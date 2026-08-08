/*
 * 通知用の関数 (GAS 版) の入口。Google の API に触るのはこの1枚だけで、
 * 判断は logic.gs が受け持つ (そちらは vitest で検査している)。
 *
 * Apps Script の web アプリは `/exec` 固定でパスを持てないので、行き先は
 * `?path=/notify` で受け取る。合言葉は本文に入れてもらう (独自ヘッダを
 * 付けるとブラウザが preflight を投げ、Apps Script はそれに答えられない)。
 *
 * 事前に「プロジェクトの設定 → スクリプト プロパティ」へ入れておくもの:
 *   VAPID_PUBLIC_KEY   base64url の公開鍵
 *   VAPID_PRIVATE_KEY  PEM の秘密鍵 (-----BEGIN PRIVATE KEY----- から始まるもの)
 *   VAPID_SUBJECT      mailto:あなたのアドレス
 *   TOKENS             {"g_xxxx":"グループごとの合言葉"} の JSON
 *   DRIVE_FOLDER_ID    Drive を置き場にするときだけ。グループのフォルダの ID
 *   WEBDAV_BASE_URL    WebDAV の置き場で上りを受けるときだけ。書き込み用の URL
 *   WEBDAV_USERNAME    同上
 *   WEBDAV_PASSWORD    同上
 */

/* eslint-disable */

var MOFUNE_PUSH_TTL_SECONDS = 24 * 60 * 60
var MOFUNE_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

function mofuneProps() {
  return PropertiesService.getScriptProperties()
}

/** 購読名簿の置き場。関数が持つ状態はこれと VAPID 鍵だけ。 */
function mofuneStore() {
  var props = mofuneProps()
  return {
    get: function (key) {
      return props.getProperty(key)
    },
    put: function (key, value) {
      props.setProperty(key, value)
    },
  }
}

function mofuneTokens() {
  try {
    return JSON.parse(mofuneProps().getProperty('TOKENS') || '{}')
  } catch (error) {
    return {}
  }
}

/** 署名する相手は push サービスのオリジン。購読ごとの URL ではない。 */
function mofuneAudience(endpoint) {
  var match = /^(https?:\/\/[^/]+)/.exec(endpoint)
  return match ? match[1] : endpoint
}

/**
 * VAPID (RFC 8292) の署名。ES256 は Apps Script が持っていないので
 * jsrsasign を同じプロジェクトに入れて使う (README の手順を参照)。
 */
function mofuneVapidHeaders(endpoint) {
  var props = mofuneProps()
  var now = Math.floor(Date.now() / 1000)
  var header = { typ: 'JWT', alg: 'ES256' }
  var claims = {
    aud: mofuneAudience(endpoint),
    exp: now + MOFUNE_TOKEN_LIFETIME_SECONDS,
    sub: props.getProperty('VAPID_SUBJECT'),
  }
  var jwt = KJUR.jws.JWS.sign(
    'ES256',
    JSON.stringify(header),
    JSON.stringify(claims),
    props.getProperty('VAPID_PRIVATE_KEY'),
  )
  return {
    Authorization: 'vapid t=' + jwt + ', k=' + props.getProperty('VAPID_PUBLIC_KEY'),
    TTL: String(MOFUNE_PUSH_TTL_SECONDS),
  }
}

/** 中身は送らない。端末は起こされてから自分で取りに行く。 */
function mofuneSendPush(endpoint) {
  var response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    headers: mofuneVapidHeaders(endpoint),
    contentLength: 0,
    muteHttpExceptions: true,
  })
  return response.getResponseCode()
}

/**
 * Drive をグループの置き場にする。Apps Script は所有者の権限で動くので、
 * ここでの読み書きに OAuth の受け渡しは要らない。
 *
 * 鍵 (g_xxx/messages/m_1.enc) は `/` を `__` に置き換えた1階層のファイル名で
 * 持つ。フォルダを掘ると、1件読むたびに階層をたどることになって遅い。
 */
function mofuneFolder() {
  var id = mofuneProps().getProperty('DRIVE_FOLDER_ID')
  return id ? DriveApp.getFolderById(id) : null
}

function mofuneFileName(key) {
  return key.split('/').join('__')
}

function mofuneKeyOf(name) {
  return name.split('__').join('/')
}

function mofuneFindFile(folder, key) {
  var found = folder.getFilesByName(mofuneFileName(key))
  return found.hasNext() ? found.next() : null
}

function mofuneDrive() {
  return {
    get: function (key) {
      var folder = mofuneFolder()
      if (!folder) return null
      var file = mofuneFindFile(folder, key)
      // 中身は封緘済みのバイト列。base64 の文字列として持ち回る
      return file ? Utilities.base64Encode(file.getBlob().getBytes()) : null
    },
    put: function (key, base64Body) {
      var folder = mofuneFolder()
      if (!folder) throw new Error('DRIVE_FOLDER_ID is not set')
      var bytes = Utilities.base64Decode(base64Body)
      var blob = Utilities.newBlob(bytes, 'application/octet-stream', mofuneFileName(key))
      var existing = mofuneFindFile(folder, key)
      if (existing) {
        // 上書きは作り直し。Drive は同名を許すので、消してから置く
        existing.setTrashed(true)
      }
      folder.createFile(blob)
    },
    remove: function (key) {
      var folder = mofuneFolder()
      if (!folder) return
      var file = mofuneFindFile(folder, key)
      if (file) file.setTrashed(true)
    },
    list: function (prefix) {
      var folder = mofuneFolder()
      if (!folder) return []
      var entries = []
      var files = folder.getFiles()
      while (files.hasNext()) {
        var file = files.next()
        var key = mofuneKeyOf(file.getName())
        if (key.indexOf(prefix) === 0) {
          entries.push({ key: key, size: file.getSize() })
        }
      }
      return entries
    },
  }
}

/**
 * WebDAV (Nextcloud・NAS) を置き場にするグループの受け口。
 *
 * この場合、アプリは NAS を直に読み書きする。関数が要るのは**上りだけ**で、
 * 参加者は資格情報を持てないため、引換券を確かめて代わりに置く役をする。
 *
 * WebDAV は親フォルダが無いと PUT を断る (409)。断られたら上から順に掘る。
 */
function mofuneWebdavConfig() {
  var props = mofuneProps()
  var baseUrl = props.getProperty('WEBDAV_BASE_URL')
  if (!baseUrl) return null
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    headers: {
      Authorization:
        'Basic ' +
        Utilities.base64Encode(
          props.getProperty('WEBDAV_USERNAME') + ':' + props.getProperty('WEBDAV_PASSWORD'),
        ),
    },
  }
}

function mofuneWebdav(config) {
  function url(key) {
    return config.baseUrl + '/' + key
  }
  function send(method, key, payload) {
    var options = { method: method, headers: config.headers, muteHttpExceptions: true }
    if (payload) {
      options.payload = payload
      options.contentType = 'application/octet-stream'
    }
    return UrlFetchApp.fetch(url(key), options)
  }
  function makeFolders(key) {
    var parts = key.split('/')
    parts.pop()
    var walked = ''
    for (var i = 0; i < parts.length; i += 1) {
      walked = walked === '' ? parts[i] : walked + '/' + parts[i]
      send('mkcol', walked)
    }
  }
  return {
    get: function (key) {
      var response = send('get', key)
      if (response.getResponseCode() >= 300) return null
      return Utilities.base64Encode(response.getBlob().getBytes())
    },
    put: function (key, base64Body) {
      var payload = Utilities.newBlob(Utilities.base64Decode(base64Body))
      var response = send('put', key, payload)
      var code = response.getResponseCode()
      if (code === 409 || code === 404) {
        makeFolders(key)
        response = send('put', key, payload)
        code = response.getResponseCode()
      }
      if (code >= 300) throw new Error('webdav put failed with ' + code)
    },
    remove: function (key) {
      send('delete', key)
    },
    list: function () {
      // 一覧はアプリが NAS を直に見る。関数側では使わない
      return []
    },
  }
}

/** 置き場は WebDAV の設定があればそちら、無ければ Drive。 */
function mofuneObjects() {
  var webdav = mofuneWebdavConfig()
  return webdav ? mofuneWebdav(webdav) : mofuneDrive()
}

/** 投函の引換券。担当者が同じ計算で作ったものだけを通す。 */
function mofuneVerifyTicket(key, ticket) {
  var tokens = mofuneTokens()
  for (var groupId in tokens) {
    if (!Object.prototype.hasOwnProperty.call(tokens, groupId)) continue
    if (key.indexOf(groupId + '/') !== 0) continue
    var signature = Utilities.computeHmacSha256Signature(key, tokens[groupId])
    var expected = Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '')
    if (expected === ticket) return true
  }
  return false
}

function mofuneDeps() {
  return {
    store: mofuneStore(),
    tokens: mofuneTokens(),
    vapidPublicKey: mofuneProps().getProperty('VAPID_PUBLIC_KEY'),
    sendPush: mofuneSendPush,
    objects: mofuneObjects(),
    verifyTicket: mofuneVerifyTicket,
  }
}

function mofuneReply(result) {
  return ContentService.createTextOutput(JSON.stringify(result.body)).setMimeType(
    ContentService.MimeType.JSON,
  )
}

function mofunePath(e) {
  return e && e.parameter && e.parameter.path ? e.parameter.path : '/'
}

function doGet(e) {
  return mofuneReply(
    handleRequest(
      {
        path: mofunePath(e),
        method: 'GET',
        body: null,
        authorization: '',
        query: e && e.parameter ? e.parameter : {},
      },
      mofuneDeps(),
    ),
  )
}

function doPost(e) {
  var body = {}
  try {
    body = JSON.parse(e.postData.contents)
  } catch (error) {
    body = {}
  }
  return mofuneReply(
    handleRequest(
      {
        path: mofunePath(e),
        method: 'POST',
        body: body,
        authorization: '',
        query: e && e.parameter ? e.parameter : {},
      },
      mofuneDeps(),
    ),
  )
}
