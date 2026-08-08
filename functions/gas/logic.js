/*
 * 通知用の関数 (GAS 版) の中身。
 *
 * Apps Script はファイルを1つの大きなスコープに並べて動かすので、import も
 * export も書けない。ここは「素の関数だけの1枚」にして、Google の API に
 * 触るところ (Code.gs) から差し込む。こうしておくと、この1枚はそのまま
 * vitest から呼べる。
 *
 * 外から見た振る舞いは Workers 版と同じでなければならない (設計書 §10.1)。
 */

/* eslint-disable */

function mofuneRegistryKey(groupId) {
  return 'registry:' + groupId
}

/** 早く返るかどうかで合言葉を当てられないようにする。 */
function mofuneSameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  var diff = 0
  for (var i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 合言葉はヘッダか本文のどちらかで来る。ブラウザから Apps Script を叩くと、
 * 独自ヘッダは preflight を呼んでしまい、Apps Script はそれに答えられない。
 */
function mofuneAuthorized(authorization, tokens, groupId, bodyToken) {
  if (typeof groupId !== 'string' || groupId === '') return false
  var given = ''
  if (typeof authorization === 'string' && authorization.indexOf('Bearer ') === 0) {
    given = authorization.slice('Bearer '.length)
  } else if (typeof bodyToken === 'string') {
    given = bodyToken
  } else {
    return false
  }
  var expected = tokens ? tokens[groupId] : undefined
  if (typeof expected !== 'string') return false
  return mofuneSameSecret(given, expected)
}

function mofuneIsRegistry(value) {
  if (value === null || typeof value !== 'object' || Object.prototype.toString.call(value) === '[object Array]') {
    return false
  }
  for (var scope in value) {
    if (!Object.prototype.hasOwnProperty.call(value, scope)) continue
    var list = value[scope]
    if (Object.prototype.toString.call(list) !== '[object Array]') return false
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i]
      if (item === null || typeof item !== 'object' || typeof item.endpoint !== 'string') {
        return false
      }
    }
  }
  return true
}

function mofuneReadRegistry(store, groupId) {
  var stored = store.get(mofuneRegistryKey(groupId))
  if (!stored) return {}
  try {
    var parsed = JSON.parse(stored)
    return mofuneIsRegistry(parsed) ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 鍵は必ず自分のグループの下でなければならない。外へ出る形も断る。 */
function mofuneKeyBelongsTo(groupId, key) {
  if (typeof key !== 'string' || key === '') return false
  if (key.indexOf('..') !== -1) return false
  return key.indexOf(groupId + '/') === 0
}

/**
 * request: { path, method, body, authorization, query }
 * deps:    { store: {get,put}, tokens, vapidPublicKey, sendPush(endpoint) -> HTTP status }
 * 返り値:  { status, body }
 */
function handleRequest(request, deps) {
  var path = request && request.path ? request.path : '/'
  var method = request && request.method ? request.method : 'GET'
  var body = request && request.body ? request.body : {}

  if (path === '/health' && method === 'GET') {
    return { status: 200, body: { ok: true, vapidPublicKey: deps.vapidPublicKey } }
  }

  if (path === '/subscriptions' && method === 'POST') {
    if (!mofuneAuthorized(request.authorization, deps.tokens, body.group_id, body.token)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    if (!mofuneIsRegistry(body.registry)) {
      return { status: 400, body: { error: 'bad registry' } }
    }
    deps.store.put(mofuneRegistryKey(body.group_id), JSON.stringify(body.registry))
    return { status: 200, body: { ok: true } }
  }

  if (path === '/notify' && method === 'POST') {
    if (!mofuneAuthorized(request.authorization, deps.tokens, body.group_id, body.token)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    var scopeId = typeof body.scope_id === 'string' ? body.scope_id : ''
    var registry = mofuneReadRegistry(deps.store, body.group_id)
    var targets = registry[scopeId] || []

    var sent = 0
    var gone = []
    var notified = []
    for (var i = 0; i < targets.length; i += 1) {
      var target = targets[i]
      var status = 0
      try {
        status = deps.sendPush(target.endpoint)
      } catch (error) {
        // 1件の失敗で残りを止めない。次に回す
        status = 0
      }
      if (status === 404 || status === 410) {
        gone.push(target.endpoint)
      } else if (status >= 200 && status < 300) {
        sent += 1
        if (typeof target.userId === 'string') notified.push(target.userId)
      }
    }

    if (gone.length > 0) {
      var kept = []
      for (var j = 0; j < targets.length; j += 1) {
        if (gone.indexOf(targets[j].endpoint) === -1) kept.push(targets[j])
      }
      registry[scopeId] = kept
      deps.store.put(mofuneRegistryKey(body.group_id), JSON.stringify(registry))
    }

    return { status: 200, body: { sent: sent, gone: gone.length, notified: notified } }
  }

  // ---- ここから下は Drive を置き場にするとき (設計書 §10.2) ----

  var query = request && request.query ? request.query : {}

  // 読みは誰でもできる。中身は封緘済みで、鍵を持つ人にしか開けない
  if (path === '/object' && method === 'GET') {
    if (!mofuneKeyBelongsTo(query.group_id, query.key)) {
      return { status: 400, body: { error: 'bad key' } }
    }
    var found = deps.objects.get(query.key)
    if (found === null || found === undefined) {
      return { status: 404, body: { error: 'not found' } }
    }
    return { status: 200, body: { body: found } }
  }

  if (path === '/object' && method === 'POST') {
    if (!mofuneAuthorized(request.authorization, deps.tokens, body.group_id, body.token)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    if (!mofuneKeyBelongsTo(body.group_id, body.key)) {
      return { status: 400, body: { error: 'bad key' } }
    }
    deps.objects.put(body.key, body.body)
    return { status: 200, body: { ok: true } }
  }

  if (path === '/list' && method === 'POST') {
    if (!mofuneKeyBelongsTo(body.group_id, body.prefix)) {
      return { status: 400, body: { error: 'bad prefix' } }
    }
    var entries = deps.objects.list(body.prefix)
    if (typeof body.after === 'string' && body.after !== '') {
      var newer = []
      for (var k = 0; k < entries.length; k += 1) {
        if (entries[k].key > body.after) newer.push(entries[k])
      }
      entries = newer
    }
    return { status: 200, body: { entries: entries } }
  }

  if (path === '/delete' && method === 'POST') {
    if (!mofuneAuthorized(request.authorization, deps.tokens, body.group_id, body.token)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    if (!mofuneKeyBelongsTo(body.group_id, body.key)) {
      return { status: 400, body: { error: 'bad key' } }
    }
    deps.objects.remove(body.key)
    return { status: 200, body: { ok: true } }
  }

  /*
   * 参加者からの投函。合言葉は渡せないので、担当者が配った引換券で確かめる。
   * 投函できるのは自分の受信箱の中だけ。ほかの場所を上書きさせない。
   */
  if (path === '/inbox' && method === 'POST') {
    if (!mofuneKeyBelongsTo(body.group_id, body.key)) {
      return { status: 400, body: { error: 'bad key' } }
    }
    if (body.key.indexOf(body.group_id + '/inbox/') !== 0) {
      return { status: 400, body: { error: 'not an inbox key' } }
    }
    if (typeof body.ticket !== 'string' || !deps.verifyTicket(body.key, body.ticket)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    deps.objects.put(body.key, body.body)
    return { status: 200, body: { ok: true } }
  }

  return { status: 404, body: { error: 'not found' } }
}

// vitest から読むためだけの出口。Apps Script には module が無いので素通りする。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { handleRequest: handleRequest }
}
