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

function mofuneDeps() {
  return {
    store: mofuneStore(),
    tokens: mofuneTokens(),
    vapidPublicKey: mofuneProps().getProperty('VAPID_PUBLIC_KEY'),
    sendPush: mofuneSendPush,
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
    handleRequest({ path: mofunePath(e), method: 'GET', body: null, authorization: '' }, mofuneDeps()),
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
    handleRequest({ path: mofunePath(e), method: 'POST', body: body, authorization: '' }, mofuneDeps()),
  )
}
