/**
 * @name NameSpoofer
 * @version 1.0.0
 * @author Lx - github@iIlusion
 * @description Locally spoofs your displayed Riot ID by rewriting the identity fields the LCU returns. Cosmetic only: others still see your real name.
 * @link https://github.com/iIlusion
 */
import Utils from './generalUtils.js';

const MODULE = 'nameSpoofer';

let _emberProvider = null;

// In-memory mirror of the persisted config (read on every hook, so keep it hot).
const cfg = {
    enabled: false,         // global master switch (turns ALL spoofing on/off)
    spoofSelf: true,       // spoof my own name
    gameName: 'Name Spoofer',
    tagLine: 'Pengu',
    friendName: 'Friend', friendNumbers: true,
    allyName: 'Ally',          // allies are always numbered
    enemyName: 'Enemy',        // enemies are always numbered
    // Shared label for misc other players (suggested/invited/honored/recently-played/invite-by-name).
    globalName: 'Player', globalNumbers: true,
    spoofFriends: false,
    spoofLobby: false,
    spoofChampSelect: false,   // non-ranked only
    spoofMatchHistory: false
};

// Real identity, captured once. `puuid` lets us spoof ourselves on generic
// (multi-player) endpoints without touching anyone else.
const real = {
    puuid: null,
    gameName: '',
    tagLine: '',
    displayName: ''
};

// Live gameflow context, updated via LCU WebSocket observe.
const ctx = { phase: 'None', isRanked: false };

// Fallback when gameData.queue.isRanked is absent.
const RANKED_QUEUES = new Set([420, 440]);

function catCfg(category) {
    switch (category) {
        case 'ally':    return [cfg.allyName, true];
        case 'enemy':   return [cfg.enemyName, true];
        case 'global':  return [cfg.globalName, cfg.globalNumbers];
        default:        return [cfg.friendName, cfg.friendNumbers];
    }
}

// Stable per-category, per-key numbering: a given key always reads "<Base> N".
// With "Include Numbers" off for the category, returns just "<Base>".
const catMaps = {};
const catCount = {};
function catLabel(category, key) {
    const [base, useNum] = catCfg(category);
    if (!useNum || !key) return base;
    const m = catMaps[category] || (catMaps[category] = {});
    if (m[key] == null) m[key] = (catCount[category] = (catCount[category] || 0) + 1);
    return base + ' ' + m[key];
}

// Known-friend membership, so friends are aliased wherever they appear (even when
// numbering is off and catLabel doesn't populate its map).
const friendPuuids = new Set();
function friendLabel(key) { if (key) friendPuuids.add(key); return catLabel('friend', key); }

// Match-history / post-game others are numbered by render order per game.
function nextOther(counters, isAlly) {
    const [base, useNum] = catCfg(isAlly ? 'ally' : 'enemy');
    if (!useNum) return base;
    return base + ' ' + (isAlly ? ++counters.ally : ++counters.enemy);
}

// Real name -> alias capture, so the DOM scrubber can fix cached renders (hovercard).
const realToAlias = {};
function noteFriend(realName, label) {
    if (realName && label && realName !== label) realToAlias[realName] = label;
}

// Track Ember component instances that we modify, so we can rerender() them
// with real data when the module is disabled.
const _emberComponents = new Set();
const _partyComponents = new Set();
function trackComponent(c) { if (c && c.element && c.rerender) _emberComponents.add(c); }
function untrackComponent(c) { if (c) _emberComponents.delete(c); }
function rerenderTracked() {
    logDebug('rerender', 'rerendering ' + _emberComponents.size + ' tracked components');
    for (const c of _emberComponents) {
        try { c.rerender(); } catch {}
    }
    _emberComponents.clear();
}

function triggerRosterRebuild() {
    const provider = _emberProvider || window.__SM_EMBER;
    logDebug('roster', 'triggerRosterRebuild provider=' + (provider ? 'yes' : 'no') + ' __SM_EMBER=' + (window.__SM_EMBER ? 'yes' : 'no'));
    if (!provider) { logDebug('roster', 'no provider -> rerenderTracked'); rerenderTracked(); return; }
    provider.getEmber().then(Ember => {
        logDebug('roster', 'got Ember, searching namespaces...');
        let hadFriendGroups = false;
        try {
            for (const ns of Ember.Namespace.NAMESPACES) {
                const c = ns.__container__;
                if (!c) continue;
                const fg = c.lookup('service:friend-groups');
                if (fg) {
                    const groups = fg.get('friendGroups');
                    logDebug('roster', 'found friendGroups, len=' + (groups ? groups.length : 'null') + ' isArray=' + Array.isArray(groups));
                    if (groups && Array.isArray(groups)) {
                        fg.set('friendGroups', groups.slice());
                        logDebug('roster', 'set friendGroups to new array');
                        hadFriendGroups = true;
                    }
                    break;
                }
            }
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] Roster rebuild failed:', e);
        }
        if (!hadFriendGroups) {
            logDebug('roster', 'no friendGroups service -> rerenderTracked');
            rerenderTracked();
        }
        rerenderTracked();
    }).catch((e) => { Utils.Debug.warn('[NameSpoofer] getEmber failed:', e); rerenderTracked(); });
}



// Match data often anonymizes puuids to all-zeros, so the alias key falls back to name.
const ZERO_PUUID = '00000000-0000-0000-0000-000000000000';
function validPuuid(p) { return p && p !== ZERO_PUUID; }

// Endpoints whose response root is us -> rewrite unconditionally (incl. `name`).
const ME_ENDPOINTS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

// Multi-player endpoints -> self-spoof + alias known friends (by puuid). Chat
// conversations/participants are where the friend hovercard reads its name from.
const GENERIC_ENDPOINTS = [
    '/lol-gameflow/v1/session',
    '/lol-chat/v1/conversations'
];

// Summoner-name resolvers (by id/puuid), used by player search/profiles AND
// champ-select cells: self+friends normally, but alias everyone as allies while
// in champ select / lobby (the cells resolve names through here).
const SUMMONER_LOOKUP = [
    '/lol-summoner/v2/summoners',
    '/lol-summoner/v1/summoners'
];

// Match-history endpoints (LCU + external SGP). Substring matching also catches
// the absolute SGP URL.
const MATCH_HISTORY_ENDPOINTS = [
    '/lol-match-history/v1/products/lol',
    '/lol-match-history/v1/games',
    'match-history-query/v1/products/lol'
];

// Post-game (end-of-game stats + honor ballot): same team-aware aliasing.
const POST_GAME_ENDPOINTS = [
    '/lol-end-of-game/v1/eog-stats-block',
    '/lol-honor-v2/v1/ballot'
];

// WebSocket pushes that carry our identity.
const ME_WS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

function loadConfig() {
    cfg.enabled = Utils.Store.get(MODULE, 'enabled') || false;
    cfg.spoofSelf = Utils.Store.get(MODULE, 'spoofSelf', true);
    cfg.gameName = Utils.Store.get(MODULE, 'gameName', 'Name Spoofer');
    cfg.tagLine = Utils.Store.get(MODULE, 'tagLine', 'Pengu');
    cfg.friendName = Utils.Store.get(MODULE, 'friendName', 'Friend') || 'Friend';
    cfg.allyName = Utils.Store.get(MODULE, 'allyName', 'Ally') || 'Ally';
    cfg.enemyName = Utils.Store.get(MODULE, 'enemyName', 'Enemy') || 'Enemy';
    cfg.globalName = Utils.Store.get(MODULE, 'globalName', 'Player') || 'Player';
    cfg.friendNumbers = Utils.Store.get(MODULE, 'friendNumbers', true);
    cfg.globalNumbers = Utils.Store.get(MODULE, 'globalNumbers', true);
    cfg.spoofFriends = Utils.Store.get(MODULE, 'spoofFriends') || false;
    cfg.spoofLobby = Utils.Store.get(MODULE, 'spoofLobby') || false;
    cfg.spoofChampSelect = Utils.Store.get(MODULE, 'spoofChampSelect') || false;
    cfg.spoofMatchHistory = Utils.Store.get(MODULE, 'spoofMatchHistory') || false;
}

function active() {
    return cfg.enabled && cfg.spoofSelf && (cfg.gameName || cfg.tagLine);
}

function aliasOthersNow() {
    if (!cfg.enabled) return false;
    if (ctx.phase === 'ChampSelect') return cfg.spoofChampSelect && !ctx.isRanked;
    if (ctx.phase === 'Lobby' || ctx.phase === 'Matchmaking' || ctx.phase === 'ReadyCheck') return cfg.spoofLobby;
    return false;
}

function logDebug(tag, msg, extra) {
    if (extra) Utils.Debug.log('[NS-DEBUG][' + tag + '] ' + msg, extra);
    else Utils.Debug.log('[NS-DEBUG][' + tag + '] ' + msg);
}

function scrubActive() {
    return cfg.enabled && ((active() && real.gameName) || aliasOthersNow() || cfg.spoofFriends || cfg.spoofMatchHistory);
}

function applyName(obj, allowName, gameName, tagLine) {
    if (!obj || typeof obj !== 'object') return;
    if (gameName) {
        for (const k of ['gameName', 'displayName', 'summonerName', 'internalName',
                         'summonerInternalName', 'riotIdGameName']) {
            if (k in obj) obj[k] = gameName;
        }
        if (allowName && 'name' in obj && typeof obj.name === 'string') obj.name = gameName;
    }
    if (tagLine != null) {
        for (const k of ['tagLine', 'gameTag', 'riotIdTagLine']) {
            if (k in obj) obj[k] = tagLine;
        }
    }
}

function hasNameField(o) {
    return o !== null && typeof o === 'object' && ('gameName' in o || 'summonerName' in o || 'riotIdGameName' in o || 'displayName' in o);
}

function nameOf(o) {
    return o.gameName || o.summonerName || o.riotIdGameName || o.displayName;
}

function puuidOf(o) {
    if (validPuuid(o.puuid)) return o.puuid;
    for (const k of ['id', 'pid']) {
        const v = o[k];
        if (typeof v === 'string') { const p = v.split('@')[0]; if (validPuuid(p)) return p; }
    }
    return null;
}

function isSelf(o, nm) {
    nm = nm || nameOf(o);
    return (validPuuid(o.puuid) && o.puuid === real.puuid)
        || (real.gameName && nm === real.gameName)
        || (cfg.gameName && nm === cfg.gameName);
}

function spoofSelf(node, isMeRoot) {
    if (Array.isArray(node)) { for (const n of node) spoofSelf(n, false); return; }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) applyName(node, isMeRoot, cfg.gameName, cfg.tagLine);
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') spoofSelf(v, false); }
}

function spoofSelfAndFriends(node, isMeRoot, selfOn) {
    if (Array.isArray(node)) { for (const n of node) spoofSelfAndFriends(n, false, selfOn); return; }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) {
        if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine);
    } else if (cfg.spoofFriends && hasNameField(node)) {
        const pu = puuidOf(node);
        if (pu && friendPuuids.has(pu)) { const l = friendLabel(pu); noteFriend(nameOf(node), l); applyName(node, true, l, ''); }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') spoofSelfAndFriends(v, false, selfOn); }
}

function aliasFriendsList(node, selfOn, category) {
    if (Array.isArray(node)) { for (const n of node) aliasFriendsList(n, selfOn, category); return; }
    if (!node || typeof node !== 'object') return;
    if (hasNameField(node)) {
        if (isSelf(node)) { if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine); }
        else {
            const pu = puuidOf(node);
            const key = pu || (node.summonerId && ('sid:' + node.summonerId)) || nameOf(node);
            if (key) {
                if (category === 'friend' && pu) friendPuuids.add(pu);
                const l = catLabel(category, key);
                noteFriend(nameOf(node), l);
                applyName(node, true, l, '');
            }
        }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') aliasFriendsList(v, selfOn, category); }
}

function applyOther(o, isAlly, counters, selfOn, readOnly) {
    if (!o || typeof o !== 'object') return;
    if (isSelf(o)) { if (selfOn && !readOnly) applyName(o, true, cfg.gameName, cfg.tagLine); return; }
    const label = nextOther(counters, isAlly);
    noteFriend(nameOf(o), label);
    if (!readOnly) applyName(o, true, label, '');
}

function aliasTeam(node, selfOn, readOnly) {
    if (Array.isArray(node)) { for (const n of node) aliasTeam(n, selfOn, readOnly); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.participantIdentities) && Array.isArray(node.participants)) {
        aliasLcuGame(node, selfOn, readOnly); return;
    }
    if (Array.isArray(node.teams) && node.teams[0] && Array.isArray(node.teams[0].players)) {
        aliasEogTeams(node, selfOn, readOnly); return;
    }
    if (Array.isArray(node.participants) && node.participants[0] && hasNameField(node.participants[0])) {
        aliasFlatParticipants(node.participants, selfOn, readOnly); return;
    }
    if (Array.isArray(node.eligiblePlayers) || Array.isArray(node.eligibleAllies) || Array.isArray(node.eligibleOpponents)) {
        const c = { ally: 0, enemy: 0 };
        for (const p of (node.eligibleAllies || node.eligiblePlayers || [])) if (p && hasNameField(p)) applyOther(p, true, c, selfOn, readOnly);
        for (const p of (node.eligibleOpponents || [])) if (p && hasNameField(p)) applyOther(p, false, c, selfOn, readOnly);
        return;
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') aliasTeam(v, selfOn, readOnly); }
}

function aliasLcuGame(game, selfOn, readOnly) {
    const pidTeam = {};
    for (const p of game.participants) pidTeam[p.participantId] = p.teamId;
    let ourTeam = null;
    for (const idn of game.participantIdentities) {
        if (idn.player && isSelf(idn.player)) { ourTeam = pidTeam[idn.participantId]; break; }
    }
    const c = { ally: 0, enemy: 0 };
    for (const idn of game.participantIdentities) {
        if (!idn.player) continue;
        const team = pidTeam[idn.participantId];
        applyOther(idn.player, ourTeam != null ? team === ourTeam : team === 100, c, selfOn, readOnly);
    }
}

function aliasEogTeams(node, selfOn, readOnly) {
    let ourTeam = null;
    for (const t of node.teams) for (const pl of (t.players || [])) if (isSelf(pl)) ourTeam = t;
    const c = { ally: 0, enemy: 0 };
    for (const t of node.teams) {
        const ally = ourTeam != null ? t === ourTeam : t === node.teams[0];
        for (const pl of (t.players || [])) applyOther(pl, ally, c, selfOn, readOnly);
    }
    if (node.localPlayer && selfOn && !readOnly) applyName(node.localPlayer, false, cfg.gameName, cfg.tagLine);
}

function aliasFlatParticipants(parts, selfOn, readOnly) {
    let ourTeam = null;
    for (const p of parts) if (isSelf(p)) { ourTeam = p.teamId; break; }
    const c = { ally: 0, enemy: 0 };
    for (const p of parts) applyOther(p, ourTeam != null ? p.teamId === ourTeam : p.teamId === 100, c, selfOn, readOnly);
}

function needsWork(opts) {
    return active() || (cfg.enabled && (opts.others || cfg.spoofFriends));
}

function transformObject(data, opts) {
    const others = opts.others;
    const selfOn = active();
    if (others === 'team') aliasTeam(data, selfOn, opts.collectOnly);
    else if (others === 'ally') aliasFriendsList(data, selfOn, 'ally');
    else if (others === 'friendsList') aliasFriendsList(data, selfOn, 'friend');
    else if (others === 'globalList') aliasFriendsList(data, selfOn, 'global');
    else spoofSelfAndFriends(data, opts.isMeRoot, selfOn);
}

function transformText(text, opts) {
    if (!text || !needsWork(opts)) return text;
    let data;
    try { data = JSON.parse(text); } catch { return text; }
    try { transformObject(data, opts); return opts.collectOnly ? text : JSON.stringify(data); }
    catch (e) { Utils.Debug.warn('[NameSpoofer] transform failed:', e); return text; }
}

let _xhrInstalled = false;
let _xhrRespGet, _xhrTextGet;
const _xhrRoutes = [];
function assertXhr() {
    const proto = XMLHttpRequest.prototype;
    if (proto.open && proto.open._nsHook) return;
    if (!_xhrRespGet) {
        _xhrRespGet = Object.getOwnPropertyDescriptor(proto, 'response').get;
        _xhrTextGet = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
    }
    const prevOpen = proto.open;
    const respGet = _xhrRespGet, textGet = _xhrTextGet;
    const nsOpen = function (m, u, ...rest) {
        const url = String(u);
        const route = _xhrRoutes.find((rt) => url.indexOf(rt.pattern) !== -1);
        if (route) {
            const opts = route.optsFn;
            let objDone = false, textCache;
            try {
                Object.defineProperty(this, 'response', {
                    configurable: true,
                    get() {
                        let raw; try { raw = respGet.call(this); } catch { return undefined; }
                        if (this.readyState !== 4 || !needsWork(opts())) return raw;
                        if (raw && typeof raw === 'object') {
                            if (!objDone) { try { transformObject(raw, opts()); } catch {} objDone = true; }
                            return raw;
                        }
                        if (typeof raw === 'string') {
                            if (textCache === undefined) textCache = transformText(raw, opts());
                            return textCache;
                        }
                        return raw;
                    }
                });
                Object.defineProperty(this, 'responseText', {
                    configurable: true,
                    get() {
                        let raw; try { raw = textGet.call(this); } catch { return ''; }
                        if (this.readyState !== 4 || typeof raw !== 'string' || !raw || !needsWork(opts())) return raw;
                        if (textCache === undefined) textCache = transformText(raw, opts());
                        return textCache;
                    }
                });
            } catch (e) {}
        }
        return prevOpen.call(this, m, u, ...rest);
    };
    nsOpen._nsHook = true;
    proto.open = nsOpen;
}
function installXhr() {
    if (_xhrInstalled) return;
    _xhrInstalled = true;
    assertXhr();
}

let _hooksInstalled = false;
function installHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;
    installXhr();

    const reg = (pattern, optsFn) => {
        Utils.Hooks.Fetch.hookRes(pattern, (text) => transformText(text, optsFn()));
        _xhrRoutes.push({ pattern, optsFn });
    };

    reg('/lol-match-history/v1/recently-played-summoners', () => ({ others: cfg.spoofFriends ? 'globalList' : false }));
    reg('/lol-summoner/v1/summoners/aliases', () => ({ others: cfg.spoofFriends ? 'friendsList' : false }));

    for (const ep of ME_ENDPOINTS) reg(ep, () => ({ isMeRoot: true, others: false }));
    for (const ep of GENERIC_ENDPOINTS) reg(ep, () => ({ isMeRoot: false, others: false }));
    for (const ep of MATCH_HISTORY_ENDPOINTS) reg(ep, () => ({ others: cfg.spoofMatchHistory ? 'team' : false, collectOnly: true }));
    for (const ep of POST_GAME_ENDPOINTS) reg(ep, () => ({ others: cfg.spoofMatchHistory ? 'team' : false, collectOnly: true }));

    Utils.Hooks.WS.install(context);
    for (const ep of ME_WS) {
        Utils.Hooks.WS.hook(ep, (_endpoint, payload) => {
            if (!active() || !payload || typeof payload !== 'object') return payload;
            try { spoofSelf(payload, true); } catch (e) { Utils.Debug.warn('[NameSpoofer] WS transform failed:', e); }
            return payload;
        });
    }
}

async function refreshContext() {
    try {
        const phase = await Utils.LCU.get('/lol-gameflow/v1/gameflow-phase');
        if (typeof phase === 'string') ctx.phase = phase;
        const s = await Utils.LCU.get('/lol-gameflow/v1/session');
        const q = s && s.gameData && s.gameData.queue;
        if (q) ctx.isRanked = !!q.isRanked || RANKED_QUEUES.has(q.id);
        logDebug('refresh', 'phase=' + ctx.phase + ' isRanked=' + ctx.isRanked + ' aliasOthersNow=' + aliasOthersNow());
    } catch { logDebug('refresh', 'fetch failed (normal during None phase)'); }
}

function decodeJwtPayload(jwt) {
    try {
        const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch { return null; }
}

async function captureRealIdentity() {
    if (!Utils.LCU) return;
    try {
        const me = await Utils.LCU.get('/lol-summoner/v1/current-summoner');
        if (me && me.puuid) real.puuid = me.puuid;

        const info = await Utils.LCU.get('/lol-rso-auth/v1/authorization/userinfo');
        const jwt = info && (info.userInfo || (typeof info === 'string' ? info : null));
        const payload = jwt ? decodeJwtPayload(jwt) : null;
        if (payload && payload.acct) {
            real.gameName = payload.acct.game_name || real.gameName;
            real.tagLine = payload.acct.tag_line || real.tagLine;
            real.displayName = real.gameName;
        }

        if (!real.puuid || !real.gameName) throw new Error('identity incomplete');
        DomScrubber.install();
        DomScrubber.sweep();
    } catch (e) {
        setTimeout(captureRealIdentity, 1500);
    }
}

const OVERRIDE_ATTR = 'puuids-to-name-overrides-json';

function restoreTextNodeText(node) {
    if (!node || !node.nodeValue) return;
    let v = node.nodeValue;
    let changed = false;
    const G = real.gameName, T = real.tagLine;
    if (!G) return;
    if (T) {
        const nv = v.split(cfg.gameName + '#' + cfg.tagLine).join(G + '#' + T).split(cfg.gameName + ' #' + cfg.tagLine).join(G + ' #' + T);
        if (nv !== v) { v = nv; changed = true; }
    }
    if (cfg.gameName && cfg.gameName !== G && v.indexOf(cfg.gameName) !== -1) { v = v.split(cfg.gameName).join(G); changed = true; }
    if (cfg.tagLine && cfg.tagLine !== T && v.indexOf(cfg.tagLine) !== -1) { v = v.split(cfg.tagLine).join(T); changed = true; }
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
    for (const alias of Object.keys(aliasToReal)) {
        const rn = aliasToReal[alias];
        if (rn !== alias && v.indexOf(alias) !== -1) { v = v.split(alias).join(rn); changed = true; }
    }
    if (changed) node.nodeValue = v;
}

const DomScrubber = {
    _installed: false,
    _frameDocs: new WeakSet(),

    install() {
        if (this._installed) return;
        this._installed = true;
        this._unobserveIframes = Utils.DOM.observer.observe('iframe', (node) => {
            const attach = () => {
                try {
                    const doc = node.contentDocument;
                    if (!doc || this._frameDocs.has(doc)) return;
                    this._frameDocs.add(doc);
                    this._applyFrameDoc(doc);
                    const mo = new MutationObserver(() => {
                        this._applyFrameDoc(doc);
                    });
                    try { mo.observe(doc.documentElement, { childList: true, subtree: true, characterData: true }); } catch {}
                } catch {}
            };
            attach();
            node.addEventListener('load', attach);
        });
    },

    _applyFrameDoc(doc) {
        if (!doc) return;
        try {
            if (scrubActive()) {
                doc.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => this._fixOverrideAttr(el));
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) aliasTextNodeText(n);
            } else if (!cfg.enabled && real.gameName) {
                doc.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => {
                    try {
                        const raw = el.getAttribute(OVERRIDE_ATTR);
                        if (!raw) return;
                        const map = JSON.parse(raw);
                        let changed = false;
                        for (const puuid in map) {
                            if (puuid === real.puuid && map[puuid] !== real.gameName) {
                                map[puuid] = real.gameName; changed = true;
                            }
                        }
                        if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
                    } catch {}
                });
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) restoreTextNodeText(n);
            }
        } catch {}
    },

    _scanFrames(fn) {
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (doc) { fn(doc); return; }
                iframe.addEventListener('load', () => {
                    try { const d = iframe.contentDocument || iframe.contentWindow?.document; if (d) fn(d); } catch {}
                }, { once: true });
            } catch {}
        });
        for (let i = 0; i < window.frames.length; i++) {
            try {
                const doc = window.frames[i].document;
                if (doc) fn(doc);
            } catch {}
        }
    },

    sweep() {
        if (!this._installed) return;
        this._frameDocs = new WeakSet();
        if (scrubActive()) {
            document.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => this._fixOverrideAttr(el));
            this._scanFrames((doc) => this._applyFrameDoc(doc));
        }
    },

    restore() {
        if (!this._installed || !real.gameName) return;
        this._frameDocs = new WeakSet();
        if (!cfg.enabled) {
            document.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => {
                try {
                    const raw = el.getAttribute(OVERRIDE_ATTR);
                    if (!raw) return;
                    const map = JSON.parse(raw);
                    let changed = false;
                    for (const puuid in map) {
                        if (puuid === real.puuid && map[puuid] !== real.gameName) {
                            map[puuid] = real.gameName; changed = true;
                        }
                    }
                    if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
                } catch {}
            });
            this._scanFrames((doc) => {
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) restoreTextNodeText(n);
            });
            const start = document.body || document.documentElement;
            if (start) {
                const tw = (start.ownerDocument || document).createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) restoreTextNodeText(n);
            }
        }
    },

    _fixOverrideAttr(el) {
        if (!el || !el.getAttribute) return;
        const selfOn = active() && cfg.gameName && real.puuid;
        const othersOn = aliasOthersNow();
        if (!selfOn && !othersOn) return;
        try {
            const raw = el.getAttribute(OVERRIDE_ATTR);
            if (!raw) return;
            const map = JSON.parse(raw);
            let changed = false;
            for (const puuid in map) {
                let desired = map[puuid];
                if (selfOn && puuid === real.puuid) desired = cfg.gameName;
                else if (othersOn && puuid !== real.puuid) desired = catLabel('ally', puuid);
                if (desired !== map[puuid]) { map[puuid] = desired; changed = true; }
            }
            if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
        } catch {}
    }
};

const spoofSummonerName = (name) => {
    if (!name) return name;
    const G = real.gameName, T = real.tagLine;
    const SG = cfg.gameName || G, ST = cfg.tagLine || T;
    let v = name;
    if (cfg.enabled) {
        if (active() && G) {
            if (T) {
                if (v.indexOf(G + '#' + T) !== -1) { v = v.split(G + '#' + T).join(SG + '#' + ST); }
                if (v.indexOf(G + ' #' + T) !== -1) { v = v.split(G + ' #' + T).join(SG + ' #' + ST); }
            }
            if (SG !== G && v.indexOf(G) !== -1) { v = v.split(G).join(SG); }
            if (T && ST !== T && v.indexOf(T) !== -1) { v = v.split(T).join(ST); }
        }
        if (cfg.spoofFriends || aliasOthersNow()) {
            for (const rn of Object.keys(realToAlias)) {
                const alias = realToAlias[rn];
                if (alias !== rn && v.indexOf(rn) !== -1) { v = v.split(rn).join(alias); }
            }
        }
    } else {
        if (G && SG !== G && v.indexOf(SG) !== -1) { v = v.split(SG).join(G); }
        if (T && ST !== T && v.indexOf(ST) !== -1) { v = v.split(ST).join(T); }
        const aliasToReal = {};
        for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
        for (const alias of Object.keys(aliasToReal)) {
            const rn = aliasToReal[alias];
            if (rn !== alias && v.indexOf(alias) !== -1) { v = v.split(alias).join(rn); }
        }
    }
    return v;
};

function applyConfig() {
    const wasEnabled = cfg.enabled;
    loadConfig();
    logDebug('cfg', 'applyConfig wasEnabled=' + wasEnabled + ' nowEnabled=' + cfg.enabled);
    if (cfg.enabled) {
        DomScrubber.sweep();
    } else {
        DomScrubber.restore();
    }
    if (wasEnabled !== cfg.enabled) {
        for (const c of _partyComponents) {
            try {
                const val = c.get && c.get('partySummonerNames');
                if (!val) continue;
                const restored = Array.isArray(val)
                    ? val.map(n => spoofSummonerName(n))
                    : spoofSummonerName(String(val));
                if (JSON.stringify(restored) !== JSON.stringify(val) && c.set) {
                    c.set('partySummonerNames', restored);
                }
            } catch {}
        }
        logDebug('cfg', 'triggering roster rebuild');
        triggerRosterRebuild();
        logDebug('cfg', 'triggerRosterRebuild returned');
    }
}

function aliasTextNodeText(node) {
    if (!node || !node.nodeValue) return;
    let v = node.nodeValue;
    let changed = false;
    if (active() && real.gameName) {
        const G = real.gameName, T = real.tagLine;
        const SG = cfg.gameName || G, ST = cfg.tagLine || T;
        if (T) {
            const nv = v.split(G + '#' + T).join(SG + '#' + ST).split(G + ' #' + T).join(SG + ' #' + ST);
            if (nv !== v) { v = nv; changed = true; }
        }
        if (SG !== G && v.indexOf(G) !== -1) { v = v.split(G).join(SG); changed = true; }
        if (ST !== T && v.indexOf(T) !== -1) { v = v.split(T).join(ST); changed = true; }
    }
    if (cfg.spoofMatchHistory || aliasOthersNow()) {
        for (const rn of Object.keys(realToAlias)) {
            const alias = realToAlias[rn];
            if (alias !== rn && v.indexOf(rn) !== -1) { v = v.split(rn).join(alias); changed = true; }
        }
    }
    if (changed) node.nodeValue = v;
}

const NAME_SELECTORS = '.name-text, .player-name__game-name, .player-game-name, .member-name, [class*="game-name"]';
const TAG_LINE_SELECTORS = '.hover-card-game-tag-text, .player-name__tag-line, [class*="game-tag"], [class*="tag-line"]';

function swapNameText(el, contextPuuid) {
    if (!el || !real.gameName) return;
    let targets = Array.from(el.querySelectorAll(NAME_SELECTORS));
    if (!targets.length) {
        const tw = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
            if (n.nodeValue && n.nodeValue.trim()) {
                targets.push(n);
                break;
            }
        }
    }
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;

    const isSelfCtx = !contextPuuid || contextPuuid === real.puuid;

    for (const target of targets) {
        let cur = (target.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
        if (!cur) continue;
        if (cfg.enabled) {
            if (active() && cur === real.gameName && cur !== cfg.gameName && isSelfCtx) {
                target.textContent = cfg.gameName; continue;
            }
            if (cfg.spoofFriends || cfg.spoofMatchHistory || aliasOthersNow()) {
                const alias = realToAlias[cur];
                if (alias && alias !== cur) { target.textContent = alias; continue; }
            }
        } else {
            if (cur === cfg.gameName && cur !== real.gameName && isSelfCtx) {
                target.textContent = real.gameName; continue;
            }
            const realName = aliasToReal[cur];
            if (realName && realName !== cur) {
                target.textContent = realName;
            }
        }
    }
    if (real.tagLine && cfg.tagLine && real.tagLine !== cfg.tagLine) {
        for (const target of el.querySelectorAll(TAG_LINE_SELECTORS)) {
            let cur = (target.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            if (!cur) continue;
            if (cfg.enabled) {
                if (cur === real.tagLine && isSelfCtx) target.textContent = cfg.tagLine;
            } else if (isSelfCtx) {
                if (cur === cfg.tagLine) target.textContent = real.tagLine;
            }
        }
    }
}

function installEmberHook() {

    Utils.Hooks.Ember.registerRule({
        name: 'ns-lol-social-identity',
        matcher: 'lol-social-identity',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                trackComponent(this);
                swapNameText(this.element);
                if (!cfg.enabled && real.gameName) {
                    const tagEl = this.element.querySelector('.tag-line, [class*="tag-line"]');
                    if (tagEl && real.tagLine && tagEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim() !== real.tagLine) {
                        tagEl.textContent = real.tagLine;
                    }
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-hovercard-content',
        matcher: (args) => args.some(arg => { const k = Object.keys(arg || {}); return k.includes('partySummonerNames') }),
        mixin(Ember) {
            return {
                init() {
                    this._super(...arguments);
                    _partyComponents.add(this);
                    this.addObserver('partySummonerNames', this, '_onPartyNamesChange');
                    Ember.run.next(this, function() {
                        this._onPartyNamesChange();
                    });
                },

                _onPartyNamesChange() {
                    const val = this.get && this.get('partySummonerNames');
                    if (!val || (Array.isArray(val) && !val.length)) return;
                    const spoofed = Array.isArray(val)
                        ? val.map(n => spoofSummonerName(n))
                        : spoofSummonerName(String(val));
                    if (JSON.stringify(spoofed) !== JSON.stringify(val) && this.set) {
                        this.set('partySummonerNames', spoofed);
                    }
                },

                willDestroy() {
                    _partyComponents.delete(this);
                    this.removeObserver('partySummonerNames', this, '_onPartyNamesChange');
                    this._super(...arguments);
                }
            };
        }
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-hovercard-component',
        matcher: 'hovercard-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                trackComponent(this);
                swapNameText(this.element, this.get && this.get('puuid'));
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-friend-finder-recent',
        matcher: 'lol-friend-finder-recent-summoner',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    const el = this.element.querySelector('.player-name__game-name, .player-game-name, .name-text');
                    if (el) {
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (cur && cur !== cfg.gameName) el.textContent = catLabel('global', 'name:' + cur);
                    }
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-friend-finder-requested',
        matcher: 'lol-friend-finder-requested-player',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    const el = this.element.querySelector('.player-name__game-name, .player-game-name, .name-text');
                    if (el) {
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (cur && cur !== cfg.gameName) el.textContent = catLabel('global', 'name:' + cur);
                    }
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name',
        matcher: 'player-name',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                trackComponent(this);
                swapNameText(this.element, this.get && (this.get('short') || this.get('puuid')));
            }
        }]
    });

    function setTextNode(el, oldText, newText) {
        const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
            if (n.textContent.replace(/[⁦-⁩‎‏]/g, '').trim() === oldText) {
                n.textContent = n.textContent.split(oldText).join(newText);
                return true;
            }
        }
        return false;
    }

    const aliasPlayerName = (el, src) => {
        const ok = aliasOthersNow();
        logDebug('aliasPlayer', 'from=' + src + ' aliasOthersNow=' + ok + ' phase=' + ctx.phase + ' hasEl=' + !!el);
        if (!el || !ok) return;
        const textEl = el.querySelector('.name-text') || el;
        const cur = textEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
        logDebug('aliasPlayer', 'cur="' + cur + '" gameName="' + cfg.gameName + '" real="' + real.gameName + '"');
        if (!cur) return;
        if (cur === real.gameName) {
            const label = cfg.gameName;
            if (label === cur) return;
            logDebug('aliasPlayer', 'self aliasing "' + cur + '" -> "' + label + '"');
            setTextNode(textEl, cur, label);
        } else if (cur !== cfg.gameName) {
            const cell = el.closest('.summoner-object');
            if (!cell) { logDebug('aliasPlayer', 'no summoner-object parent'); return; }
            const cat = cell.classList.contains('right') ? 'enemy' : 'ally';
            const label = catLabel(cat, 'name:' + cur);
            if (label === cur) { logDebug('aliasPlayer', 'label unchanged, skip'); return; }
            logDebug('aliasPlayer', 'other aliasing "' + cur + '" -> "' + label + '" cat=' + cat);
            setTextNode(textEl, cur, label);
        }
    };

    Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name-component',
        matcher: 'player-name-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                trackComponent(this);
                swapNameText(this.element, this.get && (this.get('short') || this.get('puuid')));
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name-wrapper',
        matcher: 'player-name-wrapper',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                trackComponent(this);
                if (cfg.enabled) aliasPlayerName(this.element, 'ember-didRender');
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-parties-invite-panel',
        matcher: 'v2-parties-invite-info-panel',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    this.element.querySelectorAll('.v2-parties-invite-info-panel-player').forEach((li) => {
                        const cat = li.querySelector('.invite-info-friend-icon') ? 'friend' : 'global';
                        const targets = [...li.querySelectorAll('.player-name__game-name, .player-game-name')];
                        const el = targets.length ? targets[0] : li.querySelector('.name-text, [class*="game-name"]');
                        if (!el) return;
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (!cur || cur === cfg.gameName) return;
                        const [base] = catCfg(cat);
                        if (cur === base || cur.indexOf(base + ' ') === 0) return;
                        const sid = li.getAttribute('summonerid');
                        const key = (sid && sid.length > 4) ? ('sid:' + sid) : ('name:' + cur);
                        const label = catLabel(cat, key);
                        if (cat === 'friend' && sid && sid.length > 4) friendPuuids.add('sid:' + sid);
                        realToAlias[cur] = label;
                        el.textContent = label;
                        li.querySelectorAll('.player-name__tag-line').forEach((t) => { t.textContent = ''; });
                    });
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-invite-dialog',
        matcher: 'parties-invite-dialog',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    this.element.querySelectorAll('.invite-dialog-friend').forEach((li) => {
                        const targets = [...li.querySelectorAll('.player-name__game-name, .player-game-name')];
                        const el = targets.length ? targets[0] : li.querySelector('.name-text, [class*="game-name"]');
                        if (!el) return;
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (!cur || cur === cfg.gameName) return;
                        const [base] = catCfg('global');
                        if (cur === base || cur.indexOf(base + ' ') === 0) return;
                        const sid = li.getAttribute('summonerid');
                        const key = (sid && sid.length > 4) ? ('sid:' + sid) : ('name:' + cur);
                        const label = catLabel('global', key);
                        realToAlias[cur] = label;
                        el.textContent = label;
                        li.querySelectorAll('.player-name__tag-line').forEach((t) => { t.textContent = ''; });
                    });
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-player-history-row',
        matcher: 'player-history-object',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element || !real.gameName) return;
                const nameEl = this.element.querySelector('.player-history-mode');
                if (!nameEl) return;
                trackComponent(this);
                let cur = (nameEl.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
                if (!cur) return;
                if (cfg.enabled) {
                    if (active() && cur === real.gameName && cur !== cfg.gameName) {
                        nameEl.textContent = cfg.gameName;
                    } else if (cfg.spoofMatchHistory) {
                        const alias = realToAlias[cur];
                        if (alias && alias !== cur) {
                            nameEl.textContent = alias;
                        }
                    }
                } else {
                    const aliasToReal = {};
                    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
                    if (cur === cfg.gameName && cur !== real.gameName) {
                        nameEl.textContent = real.gameName;
                    } else {
                        const realName = aliasToReal[cur];
                        if (realName && realName !== cur) {
                            nameEl.textContent = realName;
                        }
                    }
                }
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'ns-roster-member',
        matcher: 'lol-social-roster-member',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                const nameEl = this.element.querySelector('.member-name, .player-name__game-name, .player-game-name, .name-text, [class*="game-name"]');
                if (!nameEl) { logDebug('hook', 'ns-roster-member no nameEl'); return; }
                const cur = nameEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    if (cur && cur !== cfg.gameName) {
                        const [base] = catCfg('friend');
                        if (cur !== base && cur.indexOf(base + ' ') !== 0) {
                            const label = catLabel('friend', 'name:' + cur);
                            realToAlias[cur] = label;
                            nameEl.textContent = label;
                            logDebug('hook', 'ns-roster-member spoofed "' + cur + '" -> "' + label + '"');
                        }
                    }
                } else if (!cfg.enabled) {
                    const realName = typeof this.get === 'function' && this.get('gameName');
                    if (realName && cur !== realName) {
                        nameEl.textContent = realName;
                        logDebug('hook', 'ns-roster-member restored "' + cur + '" -> "' + realName + '"');
                    } else {
                        logDebug('hook', 'ns-roster-member skipped disabled cur="' + cur + '" real=' + (realName || 'none'));
                    }
                } else {
                    logDebug('hook', 'ns-roster-member skipped cfg.enabled=' + cfg.enabled + ' spoofFriends=' + cfg.spoofFriends);
                }
            }
        }]
    });


}

export function init(context) {
    loadConfig();
    installHooks(context);
    installEmberHook();
    if (context && context.rcp) {
        context.rcp.postInit('rcp-fe-ember-libs', (api) => { _emberProvider = api; });
    }
    captureRealIdentity();
    refreshContext();

    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
            const prev = ctx.phase;
            ctx.phase = e.data || ctx.phase;
            logDebug('phase', 'phase=' + ctx.phase + ' prev=' + prev + ' enabled=' + cfg.enabled + ' aliasOthersNow=' + aliasOthersNow());
            if (!cfg.enabled) return;
            const p = e.data;
            if (p === 'Lobby' || p === 'Matchmaking' || p === 'ReadyCheck' || p === 'ChampSelect') {
                Utils.LCU.get('/lol-gameflow/v1/session').then(s => {
                    const q = s && s.gameData && s.gameData.queue;
                    if (q) ctx.isRanked = !!q.isRanked || RANKED_QUEUES.has(q.id);
                    logDebug('session', 'isRanked=' + ctx.isRanked + ' queueId=' + (q ? q.id : 'null') + ' q.isRanked=' + (q ? q.isRanked : 'null'));
                }).catch(() => { logDebug('session', 'fetch failed (404 normal during some phases)'); });
                if (p === 'ChampSelect') {
                    // Fallback scan in case Ember hook misses async name resolution
                    setTimeout(() => {
                        document.querySelectorAll('.player-name-wrapper.ember-view').forEach(el => aliasPlayerName(el, 'scan'));
                    }, 1500);
                }
            }
        });
    }

    setupSettings(context);
}

const DESCRIPTION = 'Locally replaces your displayed Riot ID and optionally aliases other players (Friend / Ally / Enemy / Player) in the friends list, lobby, non-ranked champ select, and match history / post-game. Cosmetic only — nothing leaves your client.';

const PLUGIN_CFG = {
    name: 'name-spoofer-settings',
    titleKey: 'lx_name-spoofer',
    titleName: 'Name Spoofer',
    capitalTitleKey: 'lx_name-spoofer_capital',
    capitalTitleName: 'NAME SPOOFER',
    class: 'name-spoofer-settings'
};

function setupSettings(context) {
    Utils.Settings.inject(context, PLUGIN_CFG);
    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: MODULE,
            name: 'Name Spoofer',
            description: DESCRIPTION,
            settings: [
                { type: 'toggle', id: 'enabled', label: 'Enable Name Spoofer (master)', value: cfg.enabled, onChange: (v) => saveCfg('enabled', v) },
                { type: 'custom', render: (row) => buildSettings(row) }
            ]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.name-spoofer-settings', (container) => buildSettings(container));
    }
}

function saveCfg(key, val) { Utils.Store.set(MODULE, key, val); applyConfig(); }

function sectionTitle(text) {
    const t = document.createElement('div');
    t.textContent = text;
    Object.assign(t.style, { color: '#c8aa6e', fontSize: '13px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '12px' });
    return t;
}

function nameRow(label, nameKey, dflt, opts = {}) {
    const { numKey, fixedDefault, width = '150px' } = opts;
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px' });
    const lab = document.createElement('span');
    lab.textContent = label;
    Object.assign(lab.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap', flex: '0 0 80px' });
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cfg[nameKey] || '';
    input.placeholder = dflt;
    Object.assign(input.style, { width, flex: '0 0 auto', background: '#111', border: '1px solid #3e2e13', color: '#f0e6d2', padding: '7px 9px', borderRadius: '4px', outline: 'none', fontSize: '13px' });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('focus', () => { input.style.borderColor = '#c8aa6e'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#3e2e13'; });
    input.addEventListener('change', () => { const v = input.value.trim(); saveCfg(nameKey, fixedDefault ? (v || dflt) : v); });
    row.appendChild(lab);
    row.appendChild(input);
    if (numKey) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '4px', color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap', cursor: 'pointer' });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!cfg[numKey];
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => saveCfg(numKey, cb.checked));
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode('Numbers'));
        row.appendChild(wrap);
    }
    return row;
}

function buildSettings(c) {
    while (c.firstChild) c.removeChild(c.firstChild);

    c.style.display = 'flex';
    c.style.flexDirection = 'column';
    c.style.alignItems = 'stretch';
    c.style.gap = '10px';
    c.style.paddingLeft = '20px';
    c.style.marginTop = '0';
    c.style.borderLeft = '2px solid #3e2e13';

    c.appendChild(sectionTitle('My Name'));
    c.appendChild(Utils.Settings.createToggleRow('Spoof My Name', cfg.spoofSelf, (v) => saveCfg('spoofSelf', v)));
    c.appendChild(nameRow('Game Name', 'gameName', real.gameName || 'Name Spoofer', { width: '180px' }));
    c.appendChild(nameRow('Tagline', 'tagLine', real.tagLine || 'Pengu', { width: '90px' }));

    c.appendChild(sectionTitle('Where to Spoof'));
    c.appendChild(Utils.Settings.createToggleRow('Friends list / social / invite panel', cfg.spoofFriends, (v) => saveCfg('spoofFriends', v)));
    c.appendChild(Utils.Settings.createToggleRow('Lobby', cfg.spoofLobby, (v) => saveCfg('spoofLobby', v)));
    c.appendChild(Utils.Settings.createToggleRow('Champ Select (non-ranked)', cfg.spoofChampSelect, (v) => saveCfg('spoofChampSelect', v)));
    c.appendChild(Utils.Settings.createToggleRow('Match History & Post-Game', cfg.spoofMatchHistory, (v) => saveCfg('spoofMatchHistory', v)));

    c.appendChild(sectionTitle('Names for Other Players'));
    c.appendChild(nameRow('Friend', 'friendName', 'Friend', { numKey: 'friendNumbers', fixedDefault: true }));
    c.appendChild(nameRow('Ally', 'allyName', 'Ally', { fixedDefault: true }));
    c.appendChild(nameRow('Enemy', 'enemyName', 'Enemy', { fixedDefault: true }));
    c.appendChild(nameRow('Other', 'globalName', 'Player', { numKey: 'globalNumbers', fixedDefault: true }));
}

export function load() {
    assertXhr();
    DomScrubber.sweep();
}
