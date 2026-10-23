/* Mannington Black Box — application du MVP.
   Toute la logique métier (détection, backtest, moteur de risque, fills) vit dans la base :
   ce fichier lit, affiche et appelle les fonctions exposées. Seules exceptions : le rejet d'une fiche
   (update de opportunities) et l'approbation d'un gate (insert dans gate_reviews), écrits directement.
   Textes : t('clé') pour l'interface, ct(texte) pour un texte venu de la base (voir i18n.js). */
(function () {
  'use strict';
  var CFG = window.MANNINGTON_CONFIG;
  var sb = window.supabase.createClient(CFG.url, CFG.key);
  var $ = function (id) { return document.getElementById(id); };
  var t = I18N.t, ct = I18N.ct;
  var D = null;                                 // données chargées
  var UI = { anomaly: null, opp: null, strat: null, newsTheme: '', newsStatus: '' };
  var ME = null;                                // utilisateur connecté
  var VIEWS = ['apercu', 'actualites', 'anomalies', 'opportunites', 'strategies', 'paper', 'risque', 'audit'];

  /* ---------- formatage (suit la langue active) ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nf(x, d) {
    if (x == null || isNaN(x)) return '—';
    d = d == null ? 1 : d;
    return Number(x).toLocaleString(I18N.locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
  }
  function sg(x, d) { return x == null ? '—' : (x > 0 ? '+' : '') + nf(x, d); }
  function pct(x, d) { return x == null ? '—' : nf(x * 100, d) + t('u.pct'); }
  function spct(x, d) { return x == null ? '—' : sg(x * 100, d) + t('u.pct'); }
  function bp(s) { return s + ' ' + t('u.bp'); }
  function money(x, d) { return t('u.eur', { n: nf(x, d) }); }
  function eur(x) {
    if (x == null) return '—';
    var r = Math.round(x);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + money(Math.abs(r), 0);
  }
  function meur(x, d) { return t('u.meur', { n: nf(x / 1e6, d) }); }
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  function dt(ts, withYear) {
    if (!ts) return '—';
    var d = new Date(ts), s = t('u.dsep');
    return p2(d.getUTCDate()) + s + p2(d.getUTCMonth() + 1) + (withYear ? s + d.getUTCFullYear() : '') +
      ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
  }
  function day(ts) { if (!ts) return '—'; var d = new Date(ts), s = t('u.dsep'); return p2(d.getUTCDate()) + s + p2(d.getUTCMonth() + 1) + s + d.getUTCFullYear(); }
  function cls(x) { return x > 0 ? 'pos' : x < 0 ? 'neg' : ''; }
  function pill(text, kind) { return '<span class="pill' + (kind ? ' ' + kind : '') + '">' + esc(text) + '</span>'; }
  function one(x) { return Array.isArray(x) ? x[0] : x; }

  function toast(text, isErr) {
    var el = document.createElement('div');
    if (isErr) el.className = 'err';
    el.textContent = text;
    $('toast').appendChild(el);
    setTimeout(function () { el.remove(); }, isErr ? 9000 : 5000);
  }
  function fail(e) { console.error(e); toast(ct((e && e.message) || String(e)), true); }
  async function q(promise) { var r = await promise; if (r.error) throw r.error; return r.data; }

  // Libellés des valeurs de la base, recalculés à chaque changement de langue
  var LBL;
  function buildLbl() {
    function map(prefix, keys) { var o = {}; keys.forEach(function (k) { o[k] = t(prefix + '.' + k); }); return o; }
    LBL = {
      asset: map('asset', ['fx', 'equity_index', 'government_bond', 'credit', 'commodity', 'digital_asset']),
      atype: map('atype', ['statistical', 'relative_value', 'event', 'liquidity', 'regime', 'other']),
      dir: map('dir', ['long', 'short', 'spread', 'market_neutral']),
      tor: { research: [t('tor.research'), ''], rejected: [t('tor.rejected'), 'crit'], paper_trading: [t('tor.paper_trading'), 'acc'], approved: [t('tor.approved'), 'good'], live: [t('tor.live'), 'good'] },
      strat: map('strat', ['draft', 'research_candidate', 'validated', 'paper_trading', 'paused', 'retired']),
      outcome: { accepted: [t('outcome.accepted'), 'good'], rejected: [t('outcome.rejected'), 'crit'], blocked: [t('outcome.blocked'), 'warn'] },
      actor: map('actor', ['risk_engine', 'fill_simulator', 'detector', 'reconciliation', 'system']),
      obj: map('obj', ['paper_orders', 'risk_decisions', 'fills', 'anomalies', 'opportunities', 'research_runs', 'gate_reviews', 'kill_switch_events', 'system_state', 'strategies', 'strategy_versions', 'risk_limits', 'reconciliations', 'data_snapshots', 'models', 'user_roles', 'stress_scenarios']),
      verb: map('verb', ['insert', 'update', 'delete']),
      ostatus: map('ostatus', ['pending', 'filled', 'rejected', 'blocked']),
      spec: ['economic_hypothesis', 'eligible_instruments', 'signal', 'entry', 'exit', 'position_sizing', 'hedging', 'cost_model', 'validation_protocol', 'risk_profile', 'capacity', 'monitoring_retirement'].map(function (k) { return [k, t('spec.' + k)]; }),
      gate: [t('gate.1'), t('gate.2'), t('gate.3')]
    };
  }
  buildLbl();

  /* ---------- graphique en lignes (repris de la maquette) ---------- */
  function niceStep(range) {
    var raw = range / 5, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }
  function chart(el, series, o) {
    var W = o.W || 640, H = o.H || 230, L = 46, R = 14, T = 12, B = 28, n = series[0].d.length;
    if (n < 2) { el.innerHTML = '<p class="muted">' + esc(t('c.notEnough')) + '</p>'; return; }
    var all = [].concat.apply([], series.map(function (s) { return s.d; })).concat(o.lines || []);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), step = o.step || niceStep(hi - lo);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; if (hi === lo) hi = lo + step;
    var X = function (i) { return L + (W - L - R) * i / (n - 1); }, Y = function (v) { return T + (H - T - B) * (hi - v) / (hi - lo); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label) + '">';
    if (o.shadeFrom != null) s += '<rect x="' + X(o.shadeFrom) + '" y="' + T + '" width="' + (X(n - 1) - X(o.shadeFrom)) + '" height="' + (H - T - B) + '" fill="var(--accent-soft)"/>';
    for (var v = lo; v <= hi + 1e-9; v += step) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--line)" stroke-width="1"/>';
      s += '<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">' + o.fmt(v) + '</text>';
    }
    (o.lines || []).forEach(function (v) { s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="5 4"/>'; });
    o.xt.forEach(function (t) { s += '<text x="' + X(t[0]) + '" y="' + (H - 8) + '" text-anchor="' + (t[0] === 0 ? 'start' : t[0] === n - 1 ? 'end' : 'middle') + '" font-size="11" fill="var(--muted)" font-family="var(--mono)">' + esc(t[1]) + '</text>'; });
    series.forEach(function (se) {
      s += '<polyline fill="none" stroke="' + se.c + '" stroke-width="' + (se.w || 2) + '" stroke-linejoin="round" points="' + se.d.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ') + '"/>';
      if (se.dot) s += '<circle cx="' + X(n - 1) + '" cy="' + Y(se.d[n - 1]) + '" r="4" fill="' + se.c + '"/>';
    });
    el.innerHTML = s + '</svg>';
  }

  /* ---------- chargement ---------- */
  async function loadAll() {
    var r = await Promise.all([
      q(sb.from('system_state').select('*').single()),
      q(sb.from('instruments').select('*').order('symbol')),
      q(sb.from('anomalies').select('*, relationships(code,name,z_threshold), models(name,version), data_snapshots(label)').order('detected_at', { ascending: false }).limit(100)),
      q(sb.from('opportunities').select('*, relationships(name), anomalies(code), models(name,version), data_snapshots(label)').order('created_at', { ascending: false })),
      q(sb.from('strategies').select('*, strategy_versions(*, gate_reviews(*), research_runs(*, run_metrics(*), data_snapshots(label)))').order('code')),
      q(sb.from('paper_orders').select('*, instruments(symbol,name), risk_decisions(*), fills(*), strategy_versions(version, strategies(code))').order('created_at', { ascending: false }).limit(60)),
      q(sb.from('positions_live').select('*')),
      q(sb.from('risk_limits').select('*').eq('is_active', true)),
      q(sb.from('stress_scenarios').select('*, stress_results(*)').eq('is_active', true).order('name')),
      q(sb.from('reconciliations').select('*').order('created_at', { ascending: false }).limit(5)),
      q(sb.from('audit_log').select('*').order('id', { ascending: false }).limit(80)),
      q(sb.from('profiles').select('*')),
      q(sb.from('data_quality_issues').select('id', { count: 'exact', head: false }).eq('is_critical', true).is('resolved_at', null)),
      q(sb.from('models').select('name,version,is_active')),
      q(sb.from('price_bars').select('ts').order('ts', { ascending: false }).limit(1)),
      q(sb.from('paper_orders').select('id, risk_decisions(outcome)')),
      q(sb.from('user_roles').select('user_id, role')),
      q(sb.from('news_events').select('*, news_event_sources(n,name,type,url,published_at)').order('published_at', { ascending: false }).limit(150)),
      q(sb.from('news_ingest_state').select('*').maybeSingle())
    ]);
    D = { state: r[0], instruments: r[1], anomalies: r[2], opps: r[3], strategies: r[4], orders: r[5], positions: r[6], limits: r[7],
          scenarios: r[8], recons: r[9], audit: r[10], profiles: r[11], dqOpen: r[12].length, models: r[13],
          lastBar: r[14][0] ? r[14][0].ts : null, allOrders: r[15], roles: r[16], news: r[17], newsState: r[18] };
    D.news.forEach(function (n) { n.news_event_sources.sort(function (a, b) { return a.n - b.n; }); });
    D.limit = {};
    D.limits.forEach(function (l) { if (l.scope !== 'strategy') D.limit[l.limit_type] = Number(l.value); });
    D.strategies.forEach(function (s) {
      s.strategy_versions.sort(function (a, b) { return b.version - a.version; });
      s.latest = s.strategy_versions[0];
      if (s.latest) s.latest.research_runs.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    });
    // agrégats de risque
    var cap = Number(D.state.portfolio_capital), byInst = {};
    D.risk = { cap: cap, gross: 0, pnl: 0, unreal: 0, real: 0, conc: 0, concSym: null };
    D.positions.forEach(function (p) {
      D.risk.gross += Number(p.notional || 0); D.risk.unreal += Number(p.unrealized_pnl); D.risk.real += Number(p.realized_pnl);
      byInst[p.symbol] = (byInst[p.symbol] || 0) + Number(p.signed_notional || 0);
    });
    Object.keys(byInst).forEach(function (k) { var c = Math.abs(byInst[k]) / cap; if (c > D.risk.conc) { D.risk.conc = c; D.risk.concSym = k; } });
    D.risk.pnl = (D.risk.unreal + D.risk.real) / cap;
    D.risk.lev = D.risk.gross / cap;
    if (!UI.strat && D.strategies[0]) UI.strat = D.strategies[0].id;
    var open = D.anomalies.filter(function (a) { return a.status === 'new'; });
    if (!UI.anomaly || !D.anomalies.some(function (a) { return a.id === UI.anomaly; })) UI.anomaly = (open[0] || D.anomalies[0] || {}).id;
    render();
  }
  function profileName(id) { var p = D.profiles.find(function (x) { return x.id === id; }); return p ? p.full_name : t('actor.user'); }
  function myRoles() { return D.roles.filter(function (x) { return ME && x.user_id === ME.id; }).map(function (x) { return x.role; }); }
  function can() { var mine = myRoles(), a = arguments; for (var i = 0; i < a.length; i++) if (mine.indexOf(a[i]) >= 0) return true; return false; }

  /* ---------- rendu ---------- */
  function render() {
    renderStatus(); renderApercu(); renderNews(); renderAnomalies(); renderOpps(); renderStrategies(); renderPaper(); renderRisque(); renderAudit();
  }

  function renderStatus() {
    var st = D.state, rec = D.recons[0];
    $('st-risk').className = 'pill ' + (st.trading_halted ? 'crit' : 'good');
    $('st-risk').textContent = st.trading_halted ? t('st.halted') : t('st.riskOn');
    $('st-data').className = 'pill';
    $('st-data').textContent = t('st.data', { d: day(D.lastBar) });
    $('st-recon').className = 'pill ' + (!rec ? '' : rec.is_clean ? 'good' : 'crit');
    $('st-recon').textContent = !rec ? t('st.reconNever') : rec.is_clean ? t('st.reconOk', { d: day(rec.created_at) }) : t('st.reconBreak');
    $('halt').hidden = !st.trading_halted;
    $('halt-txt').textContent = st.trading_halted ? t('st.haltTxt', { d: dt(st.halted_at), r: st.halt_reason ? ' · ' + ct(st.halt_reason) : '' }) : '';
    $('kill-open').disabled = st.trading_halted;
    $('c-actualites').textContent = D.news.filter(function (n) { return Date.now() - Date.parse(n.published_at) < 864e5; }).length || '';
    $('c-anomalies').textContent = D.anomalies.filter(function (a) { return a.status === 'new'; }).length;
    $('c-opportunites').textContent = D.opps.filter(function (o) { return o.status !== 'rejected'; }).length;
    $('c-strategies').textContent = D.strategies.length;
    $('c-paper').textContent = D.positions.filter(function (p) { return Number(p.quantity) !== 0; }).length;
    $('who').textContent = ME ? (myRoles().length ? t('who.roles', { email: ME.email, n: myRoles().length }) : t('who.none', { email: ME.email })) : '';
  }

  function head(title, sub, extra) {
    return '<div class="head"><div><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></div><div class="rowbtns">' + (extra || '') + '<span class="demo">' + esc(t('demo')) + '</span></div></div>';
  }

  function renderApercu() {
    var nNew = D.anomalies.filter(function (a) { return a.status === 'new'; }).length;
    var nRes = D.opps.filter(function (o) { return o.status === 'research'; }).length;
    var nVal = D.strategies.filter(function (s) { return s.status === 'draft' || s.status === 'research_candidate'; }).length;
    var nPap = D.strategies.filter(function (s) { return s.status === 'validated' || s.status === 'paper_trading'; }).length;
    var runs = [].concat.apply([], D.strategies.map(function (s) { return [].concat.apply([], s.strategy_versions.map(function (v) { return v.research_runs; })); }))
      .filter(function (x) { return x.status === 'completed'; });
    var runsOk = runs.filter(function (x) { return x.data_snapshot_id && x.code_version && x.parameters; }).length;
    var ordN = D.allOrders.length, ordOk = D.allOrders.filter(function (o) { return one(o.risk_decisions); }).length;
    var gates = [].concat.apply([], D.strategies.map(function (s) { return [].concat.apply([], s.strategy_versions.map(function (v) { return v.gate_reviews; })); }))
      .filter(function (g) { return g.decision === 'approved'; });
    var maxGate = gates.reduce(function (m, g) { return Math.max(m, g.gate); }, 0);
    var breaks = D.recons.filter(function (x) { return !x.is_clean; }), rec = D.recons[0];
    var halts = D.audit.filter(function (a) { return a.object_type === 'kill_switch_events'; }).length;
    // état : [clé de libellé, couleur] ; 'ok.met' compte comme atteint
    var rows = [
      ['cr.repro', 'cr.reproT', runsOk + ' / ' + runs.length, runs.length ? (runsOk === runs.length ? ['ok.met', 'good'] : ['ok.gap', 'crit']) : ['ok.noRun', '']],
      ['cr.risk', 'cr.riskT', ordOk + ' / ' + ordN, ordN ? (ordOk === ordN ? ['ok.met', 'good'] : ['ok.gap', 'crit']) : ['ok.noOrder', '']],
      ['cr.kill', 'cr.killT', t('cr.killV', { n: halts }), ['ok.toTest', 'warn']],
      ['cr.recon', 'cr.reconT', !rec ? t('cr.reconNever') : t('cr.reconV', { a: breaks.filter(function (x) { return x.escalated_at; }).length, b: breaks.length }), !rec ? ['ok.toRun', 'warn'] : ['ok.met', 'good']],
      ['cr.model', 'cr.modelT', D.models.length + ' / ' + D.models.length, ['ok.met', 'good']],
      ['cr.data', 'cr.dataT', t('cr.dataV', { n: D.dqOpen }), D.dqOpen ? ['ok.defect', 'crit'] : ['ok.met', 'good']],
      ['cr.cycle', 'cr.cycleT', maxGate ? t('cr.cycleV', { n: maxGate }) : t('cr.cycleNone'), maxGate >= 3 ? ['ok.met', 'good'] : ['ok.ongoing', 'warn']]
    ];
    var done = rows.filter(function (x) { return x[3][0] === 'ok.met'; }).length;

    var todo = [];
    [[t('todo.lev'), D.risk.lev, D.limit.max_gross_leverage], [D.risk.concSym ? t('todo.concOn', { s: D.risk.concSym }) : t('todo.conc'), D.risk.conc, D.limit.max_concentration]].forEach(function (m) {
      if (m[2] && m[1] / m[2] >= 0.8) todo.push([t('todo.nearTxt', { m: esc(m[0]), p: nf(m[1] / m[2] * 100, 0) + t('u.pct') }), t('todo.risk'), pill(t('todo.near'), 'warn')]);
    });
    D.orders.slice(0, 20).forEach(function (o) {
      var d = one(o.risk_decisions);
      if (d && d.outcome !== 'accepted' && todo.length < 6) todo.push([t('todo.order', { o: esc(LBL.outcome[d.outcome][0].toLowerCase()), c: esc(o.code), r: esc(ct(d.reasons) || '') }), t('todo.paper', { d: dt(o.created_at) }), pill(LBL.outcome[d.outcome][0], LBL.outcome[d.outcome][1])]);
    });
    D.anomalies.forEach(function (a) {
      if (a.status === 'new' && todo.length < 8) todo.push([t('todo.newAno', { r: esc(ct(a.relationships.name)), z: sg(a.z_score, 2) }), t('todo.detection', { d: dt(a.detected_at) }), pill(t('todo.review'), 'acc')]);
      if (a.status === 'artefact' && todo.length < 8) todo.push([t('todo.artefact', { r: esc(ct(a.relationships.name)) }), t('todo.dq', { d: dt(a.detected_at) }), pill(t('todo.filtered'), '')]);
    });

    var stage = function (lbl, n, sub, extra) { return '<div' + (extra ? ' class="' + extra + '"' : '') + '><span class="lbl">' + esc(t(lbl)) + '</span><span class="big">' + n + '</span><span class="muted">' + esc(t(sub)) + '</span></div>'; };
    $('v-apercu').innerHTML = head(t('ov.title'), t('ov.sub')) +
      '<div class="loop">' +
      stage('ov.observe', D.instruments.filter(function (i) { return i.is_active; }).length, 'ov.observeN') +
      stage('ov.detect', nNew, 'ov.detectN') +
      stage('ov.formulate', nRes, 'ov.formulateN') +
      stage('ov.validate', nVal, 'ov.validateN', 'gate') +
      stage('ov.simulate', nPap, 'ov.simulateN') + '</div>' +
      '<div class="loopnote"><span>' + esc(t('ov.note1')) + '</span><span>' + esc(t('ov.note2')) + '</span></div>' +
      '<div class="grid2"><div class="panel"><header><h2>' + esc(t('ov.criteria')) + '</h2><span class="muted">' + esc(t('ov.done', { n: done, t: rows.length })) + '</span></header><div class="scroll"><table>' +
      '<thead><tr><th>' + esc(t('c.measure')) + '</th><th>' + esc(t('ov.target')) + '</th><th class="n">' + esc(t('ov.current')) + '</th><th>' + esc(t('c.state')) + '</th></tr></thead><tbody>' +
      rows.map(function (x) { return '<tr><td>' + esc(t(x[0])) + '</td><td class="muted">' + esc(t(x[1])) + '</td><td class="n">' + esc(x[2]) + '</td><td>' + pill(t(x[3][0]), x[3][1]) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>' +
      '<div class="panel"><header><h2>' + esc(t('todo.title')) + '</h2></header><div class="body">' +
      (todo.length ? '<ul class="checks">' + todo.map(function (x) { return '<li><span>' + x[0] + '<br><span class="muted">' + esc(x[1]) + '</span></span>' + x[2] + '</li>'; }).join('') + '</ul>' : '<p class="muted">' + esc(t('todo.none')) + '</p>') +
      '</div></div></div>';
  }

  function renderNews() {
    var st = D.newsState || {}, kind = { ok: 'good', degraded: 'warn', down: 'crit' }[st.status] || '';
    var stLbl = { ok: t('news.ok'), degraded: t('news.degraded'), down: t('news.down') }[st.status] || t('news.never');
    var sub = t('news.sub') + (t('news.untranslated') ? ' ' + t('news.untranslated') : '');
    var html = '<div class="head"><div><h1>' + esc(t('news.title')) + '</h1><p>' + esc(sub) + '</p></div>' +
      '<div class="rowbtns">' + pill(stLbl + (st.last_ok_at ? ' · ' + dt(st.last_ok_at).slice(0, 11) + ' UTC' : ''), kind) + '<span class="pill good">' + esc(t('news.real')) + '</span></div></div>';
    var themes = D.news.map(function (n) { return n.theme; }).filter(function (x, i, a) { return a.indexOf(x) === i; })
      .sort(function (a, b) { return String(ct(a)).localeCompare(String(ct(b)), I18N.locale()); });
    var list = D.news.filter(function (n) { return (!UI.newsTheme || n.theme === UI.newsTheme) && (!UI.newsStatus || n.status === UI.newsStatus); });
    html += '<div class="panel"><header><h2>' + esc(t('news.feed')) + '</h2><span class="rowbtns">' +
      '<select class="inline" id="news-theme" aria-label="' + esc(t('news.theme')) + '"><option value="">' + esc(t('news.allThemes')) + '</option>' + themes.map(function (x) { return '<option value="' + esc(x) + '"' + (x === UI.newsTheme ? ' selected' : '') + '>' + esc(ct(x)) + '</option>'; }).join('') + '</select>' +
      '<select class="inline" id="news-status" aria-label="' + esc(t('c.status')) + '"><option value="">' + esc(t('news.allStatus')) + '</option><option value="corroborated"' + (UI.newsStatus === 'corroborated' ? ' selected' : '') + '>' + esc(t('news.corroboratedP')) + '</option><option value="reported"' + (UI.newsStatus === 'reported' ? ' selected' : '') + '>' + esc(t('news.reportedP')) + '</option></select>' +
      '<span class="muted">' + esc(t('news.count', { n: list.length })) + '</span></span></header>';
    if (!list.length) html += '<p class="empty">' + esc(D.news.length ? t('news.noneFilter') : t('news.noneYet')) + (st.note && st.status !== 'ok' ? ' ' + esc(ct(st.note)) + '.' : '') + '</p>';
    else html += '<div class="scroll"><table><thead><tr><th>' + esc(t('news.published')) + '</th><th>' + esc(t('news.event')) + '</th><th>' + esc(t('news.theme')) + '</th><th>' + esc(t('news.instruments')) + '</th><th>' + esc(t('c.status')) + '</th></tr></thead><tbody>' +
      list.map(function (n) {
        var srcs = n.news_event_sources.map(function (s) { return /^https?:\/\//.test(s.url) ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.name) + '</a>' : esc(s.name); }).join(', ');
        return '<tr><td class="mono">' + dt(n.published_at).slice(0, 11) + '</td><td><b lang="fr">' + esc(n.title) + '</b><br><span class="muted">' + esc(ct(n.country)) + ' · ' + esc(ct(n.category)) + ' · ' + srcs + '</span></td>' +
          '<td>' + esc(ct(n.theme)) + '</td><td class="mono">' + esc((n.instruments || []).join(' ') || '—') + '</td><td>' + (n.status === 'corroborated' ? pill(t('news.corroborated'), 'good') : pill(t('news.reported'), '')) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    $('v-actualites').innerHTML = html + '</div>';
  }

  function renderAnomalies() {
    var canRun = can('researcher', 'admin');
    var html = head(t('ano.title'), t('ano.sub'),
      '<button class="btn" data-act="detect"' + (canRun ? '' : ' disabled') + '>' + esc(t('ano.run')) + '</button>');
    if (!D.anomalies.length) { $('v-anomalies').innerHTML = html + '<div class="panel"><p class="empty">' + esc(t('ano.none')) + '</p></div>'; return; }
    var a = D.anomalies.find(function (x) { return x.id === UI.anomaly; }) || D.anomalies[0];
    html += '<div class="grid2"><div class="panel"><header><h2>' + esc(t('ano.queue')) + '</h2><span class="muted">' + esc(t('c.select')) + '</span></header><div class="scroll"><table>' +
      '<thead><tr><th>' + esc(t('ano.rel')) + '</th><th class="n">' + esc(t('ano.z')) + '</th><th class="n">' + esc(t('ano.sig')) + '</th><th>' + esc(t('ano.trad')) + '</th><th class="n">' + esc(t('ano.gain')) + '</th><th>' + esc(t('ano.regime')) + '</th></tr></thead><tbody>' +
      D.anomalies.map(function (x) {
        var tag = x.status === 'artefact' ? pill(t('ano.artefact'), '') : x.status === 'promoted' ? pill(t('ano.promoted'), 'acc') : x.status === 'dismissed' ? pill(t('ano.dismissed'), '') : esc(LBL.atype[x.anomaly_type]);
        return '<tr class="pick' + (x.id === a.id ? ' sel' : '') + '" data-act="pick-anomaly" data-id="' + x.id + '" tabindex="0"><td><b>' + esc(ct(x.relationships.name)) + '</b><br><span class="muted">' + tag + ' · ' + day(x.bar_ts) + '</span></td>' +
          '<td class="n">' + sg(x.z_score, 2) + '</td><td class="n">' + nf(x.significance, 3) + '</td><td>' + esc(ct(x.tradability) || '—') + '</td><td class="n">' + (x.est_net_gain_bps == null ? '—' : bp(sg(x.est_net_gain_bps, 1))) + '</td><td>' + esc(ct(x.regime) || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    var chk = a.artefact_checks || {}, okP = pill(t('ano.cleared'), 'good'), koP = pill(t('ano.found'), 'crit');
    var feats = a.contributing_features || [];
    html += '<div class="panel"><header><h2>' + esc(ct(a.relationships.name)) + '</h2><span class="mono muted">' + esc(a.code) + '</span></header><div class="body">' +
      '<div><span class="lbl">' + esc(t('ano.zChart', { t: nf(a.relationships.z_threshold, 0) })) + '</span><div class="chart" id="z-chart"></div></div>' +
      '<div><span class="lbl">' + esc(t('ano.features')) + '</span><div class="contrib" style="margin-top:8px">' + feats.map(function (v) {
        return '<span>' + esc(ct(v[0])) + '</span><span class="b"><i style="width:' + Number(v[1]) + '%"></i></span><span class="mono" style="text-align:right">' + nf(v[1], 0) + t('u.pct') + '</span>';
      }).join('') + '</div></div>' +
      '<div><span class="lbl">' + esc(t('ano.checks')) + '</span><ul class="checks" style="margin-top:8px">' +
      '<li><span>' + esc(t('ano.stale')) + '</span>' + (chk.stale_data ? koP : okP) + '</li>' +
      '<li><span>' + esc(t('ano.jump')) + '</span>' + (chk.price_jump ? koP : okP) + '</li></ul></div>' +
      '<p class="mono muted">' + esc(a.models ? a.models.name + ' ' + a.models.version : '—') + ' · ' + esc(t('ano.data', { d: a.data_snapshots ? a.data_snapshots.label : '—' })) + '</p>';
    if (a.status === 'artefact') html += '<p class="muted">' + esc(t('ano.isArtefact')) + '</p>';
    else if (a.status === 'promoted') html += '<p class="muted">' + esc(t('ano.isPromoted')) + '</p>';
    else html += '<button class="btn primary" data-act="assemble" data-id="' + a.id + '"' + (can('researcher', 'portfolio_manager', 'admin') ? '' : ' disabled') + '>' + esc(t('ano.assemble')) + '</button>';
    html += '</div></div></div>';
    $('v-anomalies').innerHTML = html;
    sb.from('relationship_series').select('ts,z').eq('relationship_id', a.relationship_id).not('z', 'is', null).lte('ts', a.bar_ts).order('ts', { ascending: false }).limit(60)
      .then(function (r) {
        if (r.error || !$('z-chart')) return;
        var d = r.data.reverse().map(function (x) { return Number(x.z); }), thr = Number(a.relationships.z_threshold);
        chart($('z-chart'), [{ d: d, c: 'var(--accent)', dot: true }], { label: t('ano.zLabel'), W: 400, H: 190, step: 1, fmt: function (v) { return (v > 0 ? '+' : '') + v.toFixed(0); }, lines: [thr, -thr], xt: [[0, t('u.dayMinus') + (d.length - 1)], [d.length - 1, day(a.bar_ts).slice(0, 5)]] });
      });
  }

  function oppScore(o) { return Number(o.expected_net_return) / (Number(o.uncertainty) + Math.abs(Number(o.stress_loss)) / 3 || 1); }
  function renderOpps() {
    var html = head(t('opp.title'), t('opp.sub'));
    if (!D.opps.length) { $('v-opportunites').innerHTML = html + '<div class="panel"><p class="empty">' + esc(t('opp.none')) + '</p><p><button class="btn" data-act="go" data-v="anomalies">' + esc(t('opp.seeAno')) + '</button></p></div>'; return; }
    var live = D.opps.filter(function (o) { return o.status !== 'rejected'; }).sort(function (a, b) { return oppScore(b) - oppScore(a); });
    var dead = D.opps.filter(function (o) { return o.status === 'rejected'; });
    var o = D.opps.find(function (x) { return x.id === UI.opp; }) || live[0] || dead[0];
    var row = function (x, rank) {
      var m = rank == null ? ' muted' : '', st = LBL.tor[x.status];
      return '<tr class="pick' + (x.id === o.id ? ' sel' : '') + '" data-act="pick-opp" data-id="' + x.id + '" tabindex="0"><td class="n' + m + '">' + (rank == null ? '—' : rank) + '</td><td class="' + m.trim() + '"><b>' + esc(x.code) + '</b> · ' + esc(x.relationships ? ct(x.relationships.name) : '') + '</td><td>' + esc(LBL.dir[x.direction]) + '</td>' +
        '<td class="n">' + bp(sg(x.expected_net_return, 1)) + '</td><td class="n">± ' + bp(nf(x.uncertainty, 1)) + '</td><td class="n neg">' + bp(nf(x.stress_loss, 1)) + '</td>' +
        '<td class="n">' + (x.portfolio_correlation == null ? '—' : nf(x.portfolio_correlation, 2)) + '</td><td class="n">' + (x.capital_required == null ? '—' : meur(x.capital_required, 1)) + '</td><td>' + pill(st[0], st[1]) + '</td></tr>';
    };
    html += '<div class="panel"><header><h2>' + esc(t('opp.ranking')) + '</h2><span class="muted">' + esc(t('c.select')) + '</span></header><div class="scroll"><table><thead><tr><th class="n">' + esc(t('opp.rank')) + '</th><th>' + esc(t('opp.sheet')) + '</th><th>' + esc(t('c.side')) + '</th><th class="n">' + esc(t('opp.ret')) + '</th><th class="n">' + esc(t('opp.unc')) + '</th><th class="n">' + esc(t('opp.stress')) + '</th><th class="n">' + esc(t('opp.corr')) + '</th><th class="n">' + esc(t('opp.cap')) + '</th><th>' + esc(t('c.status')) + '</th></tr></thead><tbody>' +
      live.map(function (x, i) { return row(x, i + 1); }).join('') + dead.map(function (x) { return row(x, null); }).join('') + '</tbody></table></div></div>';
    var ev = o.evidence || {}, c = o.estimated_costs || {}, st = LBL.tor[o.status];
    var costSum = ['spread', 'fees', 'slippage', 'financing'].reduce(function (s, k) { return s + Number(c[k] || 0); }, 0);
    var kv = [
      ['opp.id', '<span class="mono">' + esc(o.code) + ' · ' + esc(o.created_at) + '</span>'],
      ['opp.venue', esc(o.venue || '—')],
      ['opp.atype', esc(LBL.atype[o.anomaly_type])],
      ['opp.evidence', esc(t('opp.evidenceTxt', { s: nf(ev.spread, 4), z: sg(ev.z_score, 2), n: ev.lookback_bars, p: ev.precedents }))],
      ['opp.dir', esc(t('opp.dirTxt', { d: LBL.dir[o.direction] }))],
      ['opp.entry', esc(ct(o.entry_conditions)) + ' · ' + esc(ct(o.invalidation_conditions))],
      ['opp.hold', esc(ct(o.holding_period)) + ' · ' + esc(ct(o.time_stop_rule))],
      ['opp.expRet', '<span class="mono">' + bp(sg(o.expected_net_return, 1)) + ' ± ' + bp(nf(o.uncertainty, 1)) + '</span>'],
      ['opp.risk', esc(ct(o.stop_logic)) + ' · ' + esc(t('opp.stressTxt', { v: bp(nf(o.stress_loss, 1)) })) + ' · ' + esc(ct(o.gap_risk) || '')],
      ['opp.costs', '<span class="mono">' + esc(t('opp.costsTxt', { s: nf(c.spread), f: nf(c.fees), sl: nf(c.slippage), fi: nf(c.financing), t: bp(nf(costSum)) })) + '</span>'],
      ['opp.impact', esc(t('opp.notComputed'))],
      ['opp.conf', o.confidence == null ? esc(t('opp.notCalibrated')) : nf(o.confidence, 2)],
      ['c.status', esc(st[0])],
      ['opp.trail', '<span class="mono">' + esc(o.models ? o.models.name + ' ' + o.models.version : '—') + ' · ' + esc(o.data_snapshots ? o.data_snapshots.label : '—') + ' · ' + esc(t('opp.anomaly', { c: o.anomalies ? o.anomalies.code : '—' })) + '</span>']
    ];
    html += '<div class="grid2"><div class="panel"><header><h2>' + esc(t('opp.sheetTitle', { c: o.code })) + '</h2>' + pill(st[0], st[1]) + '</header><div class="body"><div class="kv">' +
      kv.map(function (x) { return '<div class="k">' + esc(t(x[0])) + '</div><div>' + x[1] + '</div>'; }).join('') + '</div></div></div>' +
      '<div class="panel"><header><h2>' + esc(t('opp.who')) + '</h2></header><div class="body">' +
      '<p class="muted">' + esc(t('opp.whoTxt')) + '</p>' +
      '<ul class="checks"><li><span>' + esc(t('opp.assembled')) + '</span>' + pill(o.assembled_by === 'rule_engine' ? t('opp.ruleEngine') : o.assembled_by, '') + '</li>' +
      '<li><span>' + esc(t('opp.limits')) + '</span>' + pill(t('actor.risk_engine'), '') + '</li></ul>' +
      '<p class="muted">' + esc(t('opp.liveNote')) + '</p>' +
      '<div class="rowbtns"><button class="btn" disabled>' + esc(t('opp.goLive')) + '</button>' +
      (o.status === 'research' ? '<button class="btn" data-act="reject-opp" data-id="' + o.id + '"' + (can('researcher', 'portfolio_manager') ? '' : ' disabled') + '>' + esc(t('opp.reject')) + '</button>' : '') +
      '</div></div></div></div>';
    $('v-opportunites').innerHTML = html;
  }

  function metric(run, basis, sample) { return (run.run_metrics || []).find(function (m) { return m.basis === basis && m.sample === sample; }) || {}; }
  function renderStrategies() {
    if (!D.strategies.length) { $('v-strategies').innerHTML = head(t('str.title'), '') + '<div class="panel"><p class="empty">' + esc(t('str.none')) + '</p></div>'; return; }
    var s = D.strategies.find(function (x) { return x.id === UI.strat; }) || D.strategies[0], v = s.latest;
    var sel = '<select class="inline" id="strat-sel" aria-label="' + esc(t('c.strategy')) + '">' + D.strategies.map(function (x) { return '<option value="' + x.id + '"' + (x.id === s.id ? ' selected' : '') + '>' + esc(x.code) + '</option>'; }).join('') + '</select>';
    var html = head(s.code, t('str.sub', { n: ct(s.name), s: LBL.strat[s.status] }), sel);
    var ok = {}; v.gate_reviews.forEach(function (g) { if (g.decision === 'approved') ok[g.gate] = g; });
    var next = ok[1] ? ok[2] ? ok[3] ? 0 : 3 : 2 : 1;
    html += '<div class="gates">' + [1, 2, 3].map(function (g) {
      var lbl = '<span class="lbl">' + esc(t('str.gate', { n: g })) + '</span><b>' + esc(LBL.gate[g - 1]) + '</b>';
      if (ok[g]) return '<div class="done">' + lbl + pill(t('str.passed', { d: day(ok[g].decided_at).slice(0, 5) }), 'good') + '</div>';
      if (g === next) return '<div class="cur">' + lbl + '<button class="btn primary" data-act="gate" data-gate="' + g + '" data-id="' + v.id + '"' + (can('risk_officer', 'portfolio_manager', 'sponsor') ? '' : ' disabled') + '>' + esc(t('str.approve')) + '</button></div>';
      return '<div>' + lbl + pill(t('str.upcoming'), '') + '</div>';
    }).join('') + '<div class="off"><span class="lbl">' + esc(t('str.gate', { n: 4 })) + '</span><b>' + esc(t('str.gate4')) + '</b><span class="pill lock">' + esc(t('str.outMvp')) + '</span></div></div>';

    var runs = v.research_runs.filter(function (r) { return r.status === 'completed'; }), run = runs[0];
    var canRun = can('researcher', 'admin');
    if (!run) {
      html += '<div class="panel"><div class="body"><p class="muted">' + esc(t('str.noRun', { d: day(v.hypothesis_registered_at) })) + '</p>' +
        '<div><button class="btn primary" data-act="backtest" data-id="' + v.id + '"' + (canRun ? '' : ' disabled') + '>' + esc(t('str.runBt')) + '</button></div></div></div>';
    } else {
      var gi = metric(run, 'gross', 'in_sample'), ni = metric(run, 'net', 'in_sample'), no = metric(run, 'net', 'out_of_sample');
      var mrow = function (label, k, f, neg) { return '<tr><td>' + esc(t(label)) + '</td>' + [gi, ni, no].map(function (m) { return '<td class="n' + (neg ? ' neg' : '') + '">' + f(m[k]) + '</td>'; }).join('') + '</tr>'; };
      var first = runs[runs.length - 1], rer = runs.filter(function (r) { return r.rerun_of; })[0];
      var ratio = ni.sharpe && no.sharpe != null ? Number(no.sharpe) / Number(ni.sharpe) : null;
      var as = run.assumptions || {};
      var checks = [
        ['str.chk.hyp', new Date(v.hypothesis_registered_at) <= new Date(first.created_at) ? [t('str.yes'), 'good'] : [t('str.no'), 'crit']],
        ['str.chk.ver', [run.data_snapshots.label + ' · ' + run.code_version, 'good']],
        ['str.chk.look', [t('str.chk.lookV'), 'good']],
        ['str.chk.ratio', ratio == null ? ['—', ''] : [nf(ratio, 2), ratio >= 0.5 ? 'good' : 'warn']],
        ['str.chk.ret', [spct(no.ann_return), Number(no.ann_return) > 0 ? 'good' : 'crit']],
        ['str.chk.dd', [pct(no.max_drawdown), Number(no.max_drawdown) > -0.05 ? 'good' : 'warn']],
        ['str.chk.rerun', rer ? (rer.result_hash === first.result_hash ? [t('str.chk.same'), 'good'] : [t('str.chk.diff'), 'crit']) : [t('str.chk.notYet'), '']],
        ['str.chk.wf', [t('str.chk.wfV'), 'warn']]
      ];
      html += '<div class="grid2"><div class="panel"><header><h2>' + esc(t('str.perf')) + '</h2><span class="mono muted">' + esc(t('str.run', { c: run.code })) + ' · ' + esc(run.data_snapshots.label) + '</span></header><div class="body">' +
        '<div class="chart" id="eq-chart"></div>' +
        '<div class="legend"><span><i style="background:var(--muted)"></i>' + esc(t('str.gross')) + '</span><span><i style="background:var(--accent)"></i>' + esc(t('str.net')) + '</span><span><i style="background:var(--accent-soft);height:10px"></i>' + esc(t('str.oos')) + '</span></div>' +
        '<div class="scroll"><table><thead><tr><th>' + esc(t('c.measure')) + '</th><th class="n">' + esc(t('str.colGross')) + '</th><th class="n">' + esc(t('str.colNet')) + '</th><th class="n">' + esc(t('str.colOos')) + '</th></tr></thead><tbody>' +
        mrow('str.m.ret', 'ann_return', function (x) { return spct(x); }) +
        mrow('str.m.vol', 'ann_volatility', function (x) { return pct(x); }) +
        mrow('str.m.sharpe', 'sharpe', function (x) { return nf(x, 2); }) +
        mrow('str.m.dd', 'max_drawdown', function (x) { return pct(x); }, true) +
        mrow('str.m.es', 'expected_shortfall', function (x) { return pct(x, 2); }, true) +
        mrow('str.m.trades', 'n_trades', function (x) { return nf(x, 0); }) +
        mrow('str.m.hit', 'hit_rate', function (x) { return pct(x, 0); }) +
        '</tbody></table></div>' +
        '<p class="muted">' + esc(t('str.sample', { a: day(run.period_start), b: day(run.period_end), i: as.in_sample_bars, o: as.out_of_sample_bars, l: (run.parameters || {}).leverage })) + '</p>' +
        '</div></div><div class="panel"><header><h2>' + esc(t('str.file')) + '</h2></header><div class="body"><ul class="checks">' +
        checks.map(function (c) { return '<li><span>' + esc(t(c[0])) + '</span>' + pill(c[1][0], c[1][1]) + '</li>'; }).join('') + '</ul>' +
        '<button class="btn" data-act="rerun" data-id="' + first.id + '"' + (canRun ? '' : ' disabled') + '>' + esc(t('str.rerun')) + '</button>' +
        '<p class="muted mono" id="rerun-out" hidden></p></div></div></div>';
    }
    html += '<div class="panel"><header><h2>' + esc(t('str.spec')) + '</h2><span class="mono muted">spec v' + v.version + ' · ' + esc(v.code_version || '—') + '</span></header><div class="body" style="gap:0">' +
      LBL.spec.map(function (k, i) { return '<details' + (i === 0 ? ' open' : '') + '><summary><span class="num">' + (i + 1) + '</span>' + esc(k[1]) + '</summary><p>' + esc(ct(v.spec[k[0]])) + '</p></details>'; }).join('') + '</div></div>';
    $('v-strategies').innerHTML = html;
    if (run) {
      sb.from('run_equity_curve').select('ts,gross,net').eq('run_id', run.id).order('ts').limit(5000).then(function (r) {
        if (r.error || !$('eq-chart')) return;
        var n = r.data.length, sp = Number((run.assumptions || {}).in_sample_bars) || Math.floor(n * 2 / 3);
        var lab = function (i) { var d = new Date(r.data[i].ts); return p2(d.getUTCMonth() + 1) + t('u.dsep') + d.getUTCFullYear(); };
        chart($('eq-chart'), [{ d: r.data.map(function (x) { return Number(x.gross); }), c: 'var(--muted)', w: 1.5 }, { d: r.data.map(function (x) { return Number(x.net); }), c: 'var(--accent)', w: 2.2, dot: true }],
          { label: t('str.perfLabel'), fmt: function (v) { return v.toFixed(0); }, shadeFrom: sp, xt: [[0, lab(0)], [sp, lab(sp)], [n - 1, lab(n - 1)]] });
      });
    }
  }

  function renderPaper() {
    var canOrder = can('researcher', 'portfolio_manager', 'admin');
    var th = function (k, n) { return '<th' + (n ? ' class="n"' : '') + '>' + t(k) + '</th>'; };   // clés de colonnes sans texte à échapper
    var html = head(t('pap.title'), t('pap.sub'));
    html += '<div class="panel"><header><h2>' + esc(t('pap.recent')) + '</h2><button class="btn primary" data-act="new-order"' + (canOrder ? '' : ' disabled') + '>' + esc(t('pap.newOrder')) + '</button></header>';
    if (!D.orders.length) html += '<p class="empty">' + esc(t('pap.none')) + '</p>';
    else html += '<div class="scroll"><table><thead><tr>' + th('c.tsUtc') + th('pap.order') + th('c.strategy') + th('c.instrument') + th('c.side') + th('c.qty', true) + th('pap.decision') + th('pap.fill') + '</tr></thead><tbody>' +
      D.orders.map(function (o) {
        var d = one(o.risk_decisions), f = (o.fills || [])[0], oc = d ? LBL.outcome[d.outcome] : [t('outcome.pending'), ''];
        return '<tr><td class="mono">' + dt(o.created_at) + '</td><td class="mono">' + esc(o.code) + '</td><td>' + esc(o.strategy_versions.strategies.code) + '</td><td>' + esc(o.instruments.symbol) + '</td><td>' + esc(o.side === 'buy' ? t('ord.buy') : t('ord.sell')) + '</td><td class="n">' + nf(o.quantity, 0) + '</td>' +
          '<td>' + pill(oc[0], oc[1]) + (d && d.reasons ? ' <span class="muted">' + esc(ct(d.reasons)) + '</span>' : '') + '</td>' +
          '<td>' + (f ? esc(t('pap.full')) + ' · <span class="mono">' + nf(f.quantity, 0) + ' @ ' + nf(f.price, 4) + '</span>' : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    html += '</div>';
    var rec = D.recons[0], pos = D.positions.filter(function (p) { return Number(p.quantity) !== 0 || Number(p.realized_pnl) !== 0; });
    html += '<div class="grid2 eq"><div class="panel"><header><h2>' + t('pap.positions') + '</h2><div class="rowbtns">' +
      (rec ? pill(rec.is_clean ? t('pap.reconciled', { d: day(rec.created_at).slice(0, 5) }) : t('pap.break'), rec.is_clean ? 'good' : 'crit') : pill(t('pap.never'), '')) +
      '<button class="btn" data-act="recon"' + (myRoles().length ? '' : ' disabled') + '>' + esc(t('pap.reconcile')) + '</button></div></header>';
    if (!pos.length) html += '<p class="empty">' + esc(t('pap.noPos')) + '</p>';
    else html += '<div class="scroll"><table><thead><tr>' + th('c.instrument') + th('pap.position', true) + th('pap.avg', true) + th('pap.last', true) + th('pap.unreal', true) + th('pap.real', true) + '</tr></thead><tbody>' +
      pos.map(function (p) { return '<tr><td>' + esc(p.symbol) + '</td><td class="n">' + sg(p.quantity, 0) + '</td><td class="n">' + nf(p.avg_price, 4) + '</td><td class="n">' + nf(p.last_price, 4) + '</td><td class="n ' + cls(p.unrealized_pnl) + '">' + eur(p.unrealized_pnl) + '</td><td class="n ' + cls(p.realized_pnl) + '">' + eur(p.realized_pnl) + '</td></tr>'; }).join('') +
      '<tr><td><b>' + esc(t('c.total')) + '</b></td><td></td><td></td><td></td><td class="n ' + cls(D.risk.unreal) + '"><b>' + eur(D.risk.unreal) + '</b></td><td class="n ' + cls(D.risk.real) + '"><b>' + eur(D.risk.real) + '</b></td></tr></tbody></table></div>';
    var all = D.allOrders, cnt = function (k) { return all.filter(function (o) { var d = one(o.risk_decisions); return d && d.outcome === k; }).length; };
    var fees = 0, nf_ = 0; D.orders.forEach(function (o) { (o.fills || []).forEach(function (f) { fees += Number(f.fees); nf_++; }); });
    html += '</div><div class="panel"><header><h2>' + esc(t('pap.control')) + '</h2><span class="muted">' + esc(t('pap.nOrders', { n: all.length })) + '</span></header><div class="scroll"><table><thead><tr>' + th('c.measure') + th('c.value', true) + '</tr></thead><tbody>' +
      '<tr><td>' + esc(t('pap.accepted')) + '</td><td class="n">' + cnt('accepted') + '</td></tr>' +
      '<tr><td>' + esc(t('pap.rejected')) + '</td><td class="n">' + cnt('rejected') + '</td></tr>' +
      '<tr><td>' + esc(t('pap.blocked')) + '</td><td class="n">' + cnt('blocked') + '</td></tr>' +
      '<tr><td>' + esc(t('pap.slip')) + '</td><td class="n">' + bp(nf(0.4, 1)) + '</td></tr>' +
      '<tr><td>' + esc(t('pap.fees', { n: nf_ })) + '</td><td class="n">' + money(fees, 2) + '</td></tr>' +
      '</tbody></table></div><p class="empty">' + esc(t('pap.fillNote')) + '</p></div></div>';
    $('v-paper').innerHTML = html;
  }

  function meter(label, val, lim, txt) {
    var u = lim ? Math.max(0, Math.min(1, val / lim)) : 0, k = u >= 1 ? ' crit' : u >= 0.8 ? ' warn' : '';
    return '<div class="meter' + k + '"><span>' + esc(label) + '</span><span class="mono">' + txt + '</span><div class="bar"><i style="width:' + (u * 100).toFixed(0) + '%"></i></div></div>';
  }
  function renderRisque() {
    var R = D.risk, L = D.limit;
    var html = head(t('risk.title'), t('risk.sub'));
    html += '<div class="grid2 eq"><div class="panel"><header><h2>' + esc(t('risk.hard')) + '</h2><span class="muted">' + esc(t('risk.portfolio', { c: meur(R.cap, 0) })) + '</span></header><div class="body">' +
      meter(t('risk.lev'), R.lev, L.max_gross_leverage, nf(R.lev, 2) + '× / ' + nf(L.max_gross_leverage, 1) + '×') +
      meter(t('risk.conc') + (R.concSym ? ' (' + R.concSym + ')' : ''), R.conc, L.max_concentration, pct(R.conc, 0) + ' / ' + pct(L.max_concentration, 0)) +
      meter(t('risk.loss'), Math.min(R.pnl, 0), L.max_loss, spct(R.pnl, 2) + ' / ' + pct(L.max_loss, 2)) +
      '<p class="muted">' + esc(t('risk.maxOrder', { v: money(L.max_order_notional, 0) })) + '</p></div></div>';
    var by = {};
    D.positions.forEach(function (p) { var k = p.asset_class; by[k] = by[k] || { g: 0, n: 0 }; by[k].g += Number(p.notional || 0); by[k].n += Number(p.signed_notional || 0); });
    var keys = Object.keys(by).filter(function (k) { return by[k].g > 0; }), tn = keys.reduce(function (s, k) { return s + by[k].n; }, 0);
    html += '<div class="panel"><header><h2>' + esc(t('risk.exp')) + '</h2></header>' + (keys.length ? '<div class="scroll"><table><thead><tr><th>' + esc(t('risk.class')) + '</th><th class="n">' + esc(t('risk.gross')) + '</th><th class="n">' + esc(t('risk.net')) + '</th><th class="n">' + esc(t('risk.share')) + '</th></tr></thead><tbody>' +
      keys.map(function (k) { return '<tr><td>' + esc(LBL.asset[k] || k) + '</td><td class="n">' + pct(by[k].g / R.cap, 0) + '</td><td class="n">' + spct(by[k].n / R.cap, 0) + '</td><td class="n">' + pct(by[k].g / R.gross, 0) + '</td></tr>'; }).join('') +
      '<tr><td><b>' + esc(t('c.total')) + '</b></td><td class="n"><b>' + pct(R.lev, 0) + '</b></td><td class="n"><b>' + spct(tn / R.cap, 0) + '</b></td><td class="n"><b>' + pct(1, 0) + '</b></td></tr></tbody></table></div>' : '<p class="empty">' + esc(t('risk.noExp')) + '</p>') + '</div></div>';
    html += '<div class="grid2 eq"><div class="panel"><header><h2>' + esc(t('risk.stress')) + '</h2><button class="btn" data-act="stress"' + (can('risk_officer', 'portfolio_manager', 'admin') ? '' : ' disabled') + '>' + esc(t('risk.recompute')) + '</button></header><div class="scroll"><table><thead><tr><th>' + esc(t('risk.scenario')) + '</th><th class="n">' + t('risk.pnl') + '</th><th>' + esc(t('risk.limit', { v: pct(L.max_stress_loss, 0) })) + '</th></tr></thead><tbody>' +
      D.scenarios.map(function (s) {
        var res = (s.stress_results || []).slice().sort(function (a, b) { return a.as_of < b.as_of ? 1 : -1; })[0];
        var p = res ? Number(res.portfolio_pnl_pct) : null, st = !res ? [t('risk.notComputed'), ''] : res.breached ? [t('risk.breached'), 'crit'] : p <= 0.75 * Number(res.limit_pct) ? [t('risk.near'), 'warn'] : [t('risk.ok'), 'good'];
        return '<tr><td>' + esc(ct(s.name)) + '<br><span class="muted">' + esc(ct(s.description) || '') + '</span></td><td class="n ' + cls(p) + '">' + (res ? spct(p, 2) : '—') + '</td><td>' + pill(st[0], st[1]) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    var rec = D.recons[0], need = ['max_order_notional', 'max_concentration', 'max_gross_leverage', 'max_loss', 'max_stress_loss'];
    var missing = need.filter(function (k) { return L[k] == null; }).length;
    var N = [t('c.normal'), 'good'], cond = [
      ['risk.c.kill', D.state.trading_halted ? [t('risk.c.active'), 'crit'] : N],
      ['risk.c.loss', L.max_loss != null && R.pnl > L.max_loss ? N : [t('risk.c.crossed'), 'crit']],
      ['risk.c.levConc', R.lev <= L.max_gross_leverage && R.conc <= L.max_concentration ? N : [t('risk.c.out'), 'crit']],
      ['risk.c.defined', missing ? [t('risk.c.missing', { n: missing }), 'crit'] : N],
      ['risk.c.dq', D.dqOpen ? [t('risk.c.open', { n: D.dqOpen }), 'crit'] : N],
      ['risk.c.recon', !rec ? [t('risk.c.never'), 'warn'] : rec.is_clean ? N : [t('risk.c.gap'), 'crit']],
      ['risk.c.broker', [t('risk.c.na'), '']],
      ['risk.c.model', [t('risk.c.notWatched'), '']]
    ];
    html += '<div class="panel"><header><h2>' + esc(t('risk.cond')) + '</h2>' + pill(t('risk.condN', { n: cond.filter(function (c) { return c[1][1] === 'good'; }).length, t: cond.length }), '') + '</header><div class="body"><ul class="checks">' +
      cond.map(function (c) { return '<li><span>' + esc(t(c[0])) + '</span>' + pill(c[1][0], c[1][1]) + '</li>'; }).join('') +
      '</ul><p class="muted">' + esc(t('risk.condNote')) + '</p></div></div></div>';
    $('v-risque').innerHTML = html;
  }

  function renderAudit() {
    var html = head(t('aud.title'), t('aud.sub'));
    var o = D.orders.find(function (x) { return (x.fills || []).length; });
    if (o) {
      var f = o.fills[0], d = one(o.risk_decisions), s = D.strategies.find(function (x) { return x.code === o.strategy_versions.strategies.code; });
      var run = s && s.latest ? s.latest.research_runs.filter(function (r) { return r.status === 'completed'; })[0] : null;
      var steps = [run ? run.data_snapshots.label : null, run ? t('str.run', { c: run.code }) : null, 'spec v' + o.strategy_versions.version + ' · ' + o.strategy_versions.strategies.code, t('aud.risk', { o: LBL.outcome[d.outcome][0].toLowerCase() }), t('aud.order', { c: o.code }), t('aud.fill', { q: nf(f.quantity, 0), p: nf(f.price, 4) })].filter(Boolean);
      html += '<div class="panel"><header><h2>' + esc(t('aud.lineage', { d: dt(o.created_at) })) + '</h2></header><div class="body"><div class="chain">' +
        steps.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('<b>→</b>') + '</div></div></div>';
    }
    html += '<div class="panel"><header><h2>' + esc(t('aud.log')) + '</h2><span class="muted">' + esc(t('aud.logSub', { n: D.audit.length })) + '</span></header><div class="scroll"><table><thead><tr><th>' + esc(t('c.tsUtc')) + '</th><th>' + esc(t('aud.actor')) + '</th><th>' + esc(t('aud.action')) + '</th><th>' + esc(t('aud.object')) + '</th><th>' + esc(t('aud.hash')) + '</th></tr></thead><tbody>' +
      D.audit.map(function (a) {
        var n = (a.payload || {}).new || {}, extra = '';
        if (a.object_type === 'risk_decisions' && n.outcome) extra = ' : ' + LBL.outcome[n.outcome][0].toLowerCase() + (n.reasons ? ', ' + ct(n.reasons) : '');
        if (a.object_type === 'kill_switch_events') extra = ' : ' + (n.action === 'resume' ? t('aud.resume') : t('aud.halt')) + (n.automatic ? t('aud.auto') : '') + (n.reason ? ', ' + ct(n.reason) : '');
        if (a.object_type === 'gate_reviews') extra = ' : ' + t('aud.gate', { n: n.gate, d: n.decision === 'approved' ? t('aud.approved') : t('aud.rejected') });
        if (a.object_type === 'paper_orders' && n.status) extra = ' : ' + (LBL.ostatus[n.status] || n.status);
        if (extra && I18N.lang() !== 'fr') extra = extra.replace(/^ : /, ': ');
        var actor = a.actor_label === 'user' ? profileName(a.actor_id) : (LBL.actor[a.actor_label] || a.actor_label);
        return '<tr><td class="mono">' + dt(a.ts) + '</td><td>' + esc(actor) + '</td><td>' + esc((LBL.obj[a.object_type] || a.object_type) + ' ' + (LBL.verb[a.action] || a.action) + extra) + '</td><td class="mono">' + esc((a.object_id || '').length > 20 ? a.object_id.slice(0, 8) + '…' : a.object_id) + '</td><td class="mono muted">' + esc(a.hash.slice(0, 4) + '…' + a.hash.slice(-4)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    $('v-audit').innerHTML = html;
  }

  /* ---------- navigation ---------- */
  function show(v) {
    if (VIEWS.indexOf(v) < 0) v = 'apercu';
    VIEWS.forEach(function (n) { $('v-' + n).hidden = n !== v; });
    Array.prototype.forEach.call($('nav').children, function (b) {
      if (b.dataset.v === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    try { history.replaceState(null, '', '#' + v); } catch (e) { /* sans importance */ }
    window.scrollTo(0, 0);
  }
  $('nav').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) show(b.dataset.v); });

  /* ---------- actions ---------- */
  var ACT = {
    'pick-anomaly': function (el) { UI.anomaly = el.dataset.id; renderAnomalies(); },
    'pick-opp': function (el) { UI.opp = el.dataset.id; renderOpps(); },
    go: function (el) { show(el.dataset.v); },
    detect: async function () {
      var n = await q(sb.rpc('run_detection'));
      toast(n ? t('msg.detected', { n: n }) : t('msg.noDetect'));
      await loadAll();
    },
    assemble: async function (el) {
      var code = await q(sb.rpc('assemble_opportunity', { p_anomaly_id: el.dataset.id }));
      toast(t('msg.assembled', { c: code }));
      await loadAll(); show('opportunites');
    },
    'reject-opp': async function (el) {
      await q(sb.from('opportunities').update({ status: 'rejected' }).eq('id', el.dataset.id));
      toast(t('msg.rejected')); await loadAll();
    },
    backtest: async function (el) {
      var code = await q(sb.rpc('run_backtest', { p_version_id: el.dataset.id }));
      toast(t('msg.backtest', { c: code })); await loadAll();
    },
    rerun: async function (el) {
      var r = await q(sb.rpc('rerun_backtest', { p_run_id: el.dataset.id }));
      await loadAll();
      var o = $('rerun-out');
      if (o) { o.hidden = false; o.textContent = t('msg.rerun', { o: r.original, r: r.rerun, res: r.identical ? t('msg.identical') : t('msg.different'), data: r.same_data ? '' : t('msg.dataChanged'), h: r.hash.slice(0, 8) }); }
    },
    gate: async function (el) {
      var s = D.strategies.find(function (x) { return x.latest && x.latest.id === el.dataset.id; }), g = Number(el.dataset.gate);
      var runs = s.latest.research_runs.filter(function (r) { return r.status === 'completed'; });
      var evidence = { hypothesis_registered_at: s.latest.hypothesis_registered_at, runs: runs.map(function (r) { return r.code; }) };
      if (runs[0]) evidence.net_out_of_sample = metric(runs[0], 'net', 'out_of_sample');
      if (g === 3) evidence.reconciliation = D.recons[0] ? D.recons[0].id : null;
      await q(sb.from('gate_reviews').insert({ strategy_version_id: el.dataset.id, gate: g, decision: 'approved', evidence: evidence }));
      toast(t('msg.gate', { g: g, s: s.code })); await loadAll();
    },
    'new-order': function () {
      var ok = D.strategies.filter(function (s) { return s.latest; });
      $('ord-strat').innerHTML = ok.map(function (s) { return '<option value="' + s.latest.id + '">' + esc(s.code) + ' · v' + s.latest.version + ' · ' + esc(LBL.strat[s.status]) + '</option>'; }).join('');
      $('ord-inst').innerHTML = D.instruments.filter(function (i) { return i.is_active; }).map(function (i) { return '<option value="' + i.id + '">' + esc(i.symbol) + ' · ' + esc(ct(i.name)) + '</option>'; }).join('');
      $('order').hidden = false; $('ord-qty').focus();
    },
    recon: async function () {
      var r = await q(sb.rpc('run_reconciliation'));
      toast(r.is_clean ? t('msg.reconOk') : t('msg.reconBreak', { n: r.breaks.length }), !r.is_clean);
      await loadAll();
    },
    stress: async function () { await q(sb.rpc('run_stress')); toast(t('msg.stress')); await loadAll(); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.disabled || !ACT[el.dataset.act]) return;
    var busy = el.tagName === 'BUTTON';
    if (busy) el.disabled = true;
    Promise.resolve(ACT[el.dataset.act](el)).catch(fail).then(function () { if (busy && document.contains(el)) el.disabled = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') ['kill', 'resume', 'order'].forEach(function (id) { $(id).hidden = true; });
    if (e.key === 'Enter') { var x = e.target.closest && e.target.closest('tr[data-act]'); if (x) x.click(); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'strat-sel') { UI.strat = e.target.value; renderStrategies(); }
    if (e.target.id === 'news-theme') { UI.newsTheme = e.target.value; renderNews(); }
    if (e.target.id === 'news-status') { UI.newsStatus = e.target.value; renderNews(); }
  });

  $('ord-cancel').onclick = function () { $('order').hidden = true; };
  $('order-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
    q(sb.rpc('submit_paper_order', {
      p_client_order_id: crypto.randomUUID(), p_strategy_version_id: $('ord-strat').value, p_instrument_id: $('ord-inst').value,
      p_side: $('ord-side').value, p_quantity: Number($('ord-qty').value)
    })).then(function (r) {
      $('order').hidden = true;
      if (r.status === 'filled') toast(t('msg.filled', { c: r.code, q: nf(r.quantity, 0), p: nf(r.fill_price, 4) }));
      else toast(t('msg.refused', { c: r.code, o: LBL.outcome[r.status][0].toLowerCase(), r: ct(r.reason) }), true);
      return loadAll();
    }).catch(fail).then(function () { btn.disabled = false; });
  });

  $('kill-open').onclick = function () { $('kill-reason').value = ''; $('kill').hidden = false; $('kill-reason').focus(); };
  $('kill-cancel').onclick = function () { $('kill').hidden = true; };
  $('kill-go').onclick = function () {
    // motif par défaut enregistré en français, comme le reste de la base ; traduit à l'affichage
    q(sb.rpc('halt_trading', { p_reason: $('kill-reason').value.trim() || 'Arrêt manuel par l\'opérateur' }))
      .then(function () { $('kill').hidden = true; toast(t('msg.halted')); return loadAll(); }).catch(fail);
  };
  $('resume-open').onclick = function () { $('r1').checked = false; $('res-reason').value = ''; $('res-go').disabled = true; $('resume').hidden = false; };
  $('res-cancel').onclick = function () { $('resume').hidden = true; };
  function resOk() { $('res-go').disabled = !($('r1').checked && $('res-reason').value.trim()); }
  $('r1').onchange = resOk; $('res-reason').oninput = resOk;
  $('res-go').onclick = function () {
    q(sb.rpc('resume_trading', { p_reason: $('res-reason').value.trim() }))
      .then(function () { $('resume').hidden = true; toast(t('msg.resumed')); return loadAll(); }).catch(fail);
  };
  $('refresh').onclick = function () { loadAll().then(function () { toast(t('msg.refreshed')); }).catch(fail); };
  $('logout').onclick = function () { sb.auth.signOut(); };

  /* ---------- langue ---------- */
  I18N.onChange(function () {
    buildLbl();
    if (D) render();                                // vues déjà chargées : simple nouveau rendu, sans rechargement
    tick();
  });

  /* ---------- session ---------- */
  function authMsg(text, kind) { var m = $('auth-msg'); m.hidden = !text; m.className = 'msg ' + (kind || ''); m.textContent = text || ''; }
  $('auth-form').addEventListener('submit', function (e) {
    e.preventDefault(); authMsg(t('auth.signingIn'));
    sb.auth.signInWithPassword({ email: $('auth-email').value.trim(), password: $('auth-pass').value }).then(function (r) {
      if (r.error) authMsg(r.error.message === 'Invalid login credentials' ? t('auth.badCreds') : r.error.message === 'Email not confirmed' ? t('auth.notConfirmed') : r.error.message, 'err');
    });
  });
  $('auth-signup').onclick = function () {
    if (!$('auth-form').reportValidity()) return;
    authMsg(t('auth.creating'));
    sb.auth.signUp({ email: $('auth-email').value.trim(), password: $('auth-pass').value, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
      if (r.error) authMsg(r.error.message, 'err');
      else if (!r.data.session) authMsg(t('auth.created'), 'ok');
    });
  };
  sb.auth.onAuthStateChange(function (event, session) {
    var inside = !!session;
    $('auth').hidden = inside; $('app').hidden = !inside;
    if (!inside) return;
    if (event === 'TOKEN_REFRESHED') return;
    setTimeout(function () {                        // hors du verrou d'authentification
      ME = session.user;
      loadAll().then(function () { renderStatus(); show((location.hash || '').slice(1)); }).catch(fail);
    }, 0);
  });

  function tick() { $('clock').textContent = dt(new Date(), true).slice(0, 16) + ' UTC'; }
  setInterval(tick, 1000);
})();
