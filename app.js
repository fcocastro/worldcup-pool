/* World Cup Family Pool — client app.
   Data sources:
     - bracket.json  : static tournament structure (matchups + feeder tree)
     - Supabase       : picks, players (name/pin/tiebreaker), results
*/
(function () {
  "use strict";

  const cfg = window.WC_CONFIG || {};
  const hasSupabase =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR-PUBLIC");

  const sb = hasSupabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  // ---- state ----
  const state = {
    bracket: null,
    roundsByKey: {},
    results: {},   // match_id -> { winner, score_a, score_b }
    picks: {},     // player -> { match_id -> team }  (saved to cloud)
    pending: {},   // match_id -> team  (selected but not yet recorded this session)
    players: {},   // name -> { pin, tiebreaker }
    games: [],         // full WC match history (optional `games` table)
    gamesByTeam: {},   // normalized team -> [ {date, stage, opp, gf, ga} ]
    order: {},         // round key -> match ids in top-to-bottom bracket order
    locks: {},         // match_id -> true when the commissioner has locked picks
    adminUnlocked: false
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };

  // Country -> ISO code for flag images (flagcdn.com). Covers all teams in the
  // bracket; add new entries here if team names ever change.
  const COUNTRY_ISO = {
    "Canada": "ca", "South Africa": "za", "Germany": "de", "Paraguay": "py",
    "Netherlands": "nl", "Morocco": "ma", "Brazil": "br", "Japan": "jp",
    "France": "fr", "Sweden": "se", "Ivory Coast": "ci", "Norway": "no",
    "Mexico": "mx", "Ecuador": "ec", "England": "gb-eng", "DR Congo": "cd",
    "United States": "us", "Bosnia and Herzegovina": "ba", "Belgium": "be",
    "Senegal": "sn", "Portugal": "pt", "Croatia": "hr", "Spain": "es",
    "Austria": "at", "Switzerland": "ch", "Algeria": "dz", "Argentina": "ar",
    "Cape Verde": "cv", "Colombia": "co", "Ghana": "gh", "Australia": "au",
    "Egypt": "eg"
  };
  function flagEl(team) {
    const iso = COUNTRY_ISO[team];
    if (!iso) return null;
    const img = document.createElement("img");
    img.className = "flag";
    img.alt = "";
    img.loading = "lazy";
    img.width = 24; img.height = 16;
    img.src = `https://flagcdn.com/w40/${iso}.png`;
    img.srcset = `https://flagcdn.com/w80/${iso}.png 2x`;
    img.onerror = () => { img.style.display = "none"; };
    return img;
  }
  const SVGNS = "http://www.w3.org/2000/svg";

  // Team-name normalization, mirroring the server fetch script, so history from
  // the API (which may spell names differently) matches our bracket names.
  const TEAM_ALIASES = {
    "united states": "usa", "us": "usa", "korea republic": "south korea",
    "ir iran": "iran", "côte d'ivoire": "ivory coast", "cote d'ivoire": "ivory coast",
    "dr congo": "congo dr", "czechia": "czech republic",
    "bosnia and herzegovina": "bosnia-herzegovina", "cape verde": "cape verde islands"
  };
  function normTeam(s) {
    if (!s) return "";
    const t = s.trim().toLowerCase();
    return TEAM_ALIASES[t] || t;
  }
  const STAGE_LABEL = {
    GROUP_STAGE: "Group", LAST_32: "R32", LAST_16: "R16", QUARTER_FINALS: "QF",
    SEMI_FINALS: "SF", THIRD_PLACE: "3rd place", FINAL: "Final"
  };
  const ROUND_STAGE = { r32: "R32", r16: "R16", qf: "QF", sf: "SF", final: "Final" };

  function toast(msg, kind) {
    const s = $("#status");
    s.textContent = msg;
    s.className = "status " + (kind || "");
    s.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (s.hidden = true), 3200);
  }

  // ---- load ----
  async function init() {
    $("#pool-title").textContent = cfg.POOL_NAME || "World Cup Family Pool";
    setupTabs();

    try {
      const res = await fetch("data/bracket.json", { cache: "no-store" });
      state.bracket = await res.json();
    } catch (e) {
      toast("Could not load bracket.json", "error");
      return;
    }
    state.bracket.rounds.forEach((r) => (state.roundsByKey[r.key] = r));
    computeOrder();
    document.title = cfg.POOL_NAME || state.bracket.poolName || document.title;

    if (!hasSupabase) {
      toast("Supabase not configured yet — see config.js / README.", "error");
    } else {
      await refreshFromCloud();
    }

    renderBracket();
    renderPicks();
    renderStandings();
    setupActions();
    setupTooltip();
  }

  async function refreshFromCloud() {
    if (!sb) return;
    const [r, p, pl, g, lk] = await Promise.all([
      sb.from("results").select("*"),
      sb.from("picks").select("*"),
      sb.from("players").select("*"),
      sb.from("games").select("*"),       // optional table; tolerated if missing
      sb.from("match_locks").select("*")  // optional table; tolerated if missing
    ]);
    state.games = (g && g.data) || [];   // full tournament history, if available
    state.locks = {};
    ((lk && lk.data) || []).forEach((row) => {
      if (row.locked) state.locks[row.match_id] = true;
    });
    state.results = {};
    (r.data || []).forEach((row) => {
      state.results[row.match_id] = {
        winner: row.winner,
        score_a: row.score_a,
        score_b: row.score_b
      };
    });
    state.picks = {};
    (p.data || []).forEach((row) => {
      (state.picks[row.player] = state.picks[row.player] || {})[row.match_id] = row.pick;
    });
    state.players = {};
    (pl.data || []).forEach((row) => {
      state.players[row.name] = { pin: row.pin, tiebreaker: row.tiebreaker };
    });
    buildGameIndex();
    refreshRoster();
  }

  // ---- bracket resolution ----
  // Returns the team name occupying a slot, or null if not yet determined.
  function resolveSlot(slot) {
    if (!slot) return null;
    if (slot.team) return slot.team;
    if (slot.from != null) {
      const res = state.results[slot.from];
      return res && res.winner ? res.winner : null;
    }
    return null;
  }
  function teamsOf(id) {
    const m = state.bracket.matches[id];
    return { a: resolveSlot(m.a), b: resolveSlot(m.b) };
  }
  function matchIdsByRound(key) {
    if (state.order[key]) return state.order[key];
    return Object.keys(state.bracket.matches)
      .filter((id) => state.bracket.matches[id].round === key)
      .sort((x, y) => Number(x) - Number(y));
  }

  // Order each round top-to-bottom by true bracket position, so a match's two
  // feeders sit directly above/below it (a real bracket, not numeric order).
  function computeOrder() {
    const m = state.bracket.matches;
    const finalId = Object.keys(m).find((id) => m[id].round === "final");
    if (!finalId) return;
    const leafOrder = [];
    (function dfs(id) {
      const mm = m[id];
      if (mm.round === "r32") { leafOrder.push(id); return; }
      dfs(String(mm.a.from));
      dfs(String(mm.b.from));
    })(finalId);
    const leafIndex = {};
    leafOrder.forEach((id, i) => (leafIndex[id] = i));
    const minLeaf = (id) => {
      const mm = m[id];
      if (mm.round === "r32") return leafIndex[id];
      return Math.min(minLeaf(String(mm.a.from)), minLeaf(String(mm.b.from)));
    };
    const order = {};
    state.bracket.rounds.forEach((r) => {
      order[r.key] = Object.keys(m)
        .filter((id) => m[id].round === r.key)
        .sort((x, y) => minLeaf(x) - minLeaf(y));
    });
    state.order = order;
  }

  // Reserved match_locks id used to lock the tiebreaker (never a real match).
  const TB_LOCK_ID = 0;
  function tiebreakerLocked() { return !!state.locks[TB_LOCK_ID]; }

  // A match accepts picks (for ordinary players) when both teams are known, the
  // commissioner hasn't locked it, and (if a kickoff time is set) kickoff hasn't
  // passed. Picking is gated by the LOCK, not by whether a result exists — the
  // commissioner locks each game to close it (do that before results come in).
  function isPickable(id) {
    const { a, b } = teamsOf(id);
    if (!a || !b) return false;
    if (state.locks[id]) return false; // commissioner-locked
    const k = state.bracket.matches[id].kickoff;
    if (k && new Date() >= new Date(k)) return false;
    return true;
  }

  // Who can edit a match: the commissioner can edit any match whose teams are
  // known — even locked or already decided (an override to fix picks).
  // Ordinary players follow isPickable (open, unlocked, not decided).
  function canEditMatch(id, isCommish) {
    const { a, b } = teamsOf(id);
    if (!a || !b) return false;
    if (isCommish) return true;
    return isPickable(id);
  }

  // A round is "fully determined" when every match in it has both teams known.
  function roundFullyDetermined(key) {
    return matchIdsByRound(key).every((id) => {
      const { a, b } = teamsOf(id);
      return a && b;
    });
  }

  // For a player, rounds that are fully determined but where some editable
  // match still has no pick (saved or pending). Used to require complete rounds.
  function incompleteRounds(name) {
    const myPicks = state.picks[name] || {};
    const out = [];
    state.bracket.rounds.forEach((round) => {
      if (!roundFullyDetermined(round.key)) return;
      const editable = matchIdsByRound(round.key).filter((id) => canEditMatch(id, false));
      if (!editable.length) return;
      const have = editable.filter((id) => {
        const sel = state.pending[id] != null ? state.pending[id] : myPicks[id];
        return sel != null;
      }).length;
      if (have < editable.length) out.push({ round, have, total: editable.length });
    });
    return out;
  }

  // ---- MAKE PICKS tab (interactive bracket) ----
  function currentName() { return $("#player-name").value.trim(); }

  // A single match node in the picking bracket.
  function pickNode(id, ctx) {
    const { a, b } = teamsOf(id);
    const res = state.results[id] || {};
    const decided = !!res.winner;
    const node = el("div", "bnode" + (decided ? " decided" : ""));
    node.dataset.match = id;

    [[a, res.score_a], [b, res.score_b]].forEach(([team, score]) => {
      const interactive = ctx.canPick && !!team;
      const row = el(interactive ? "button" : "div", "brow" + (interactive ? " brow-pick" : ""));
      // In the pick view, green means "this is the pick" — not the result.
      // Win/loss is shown by the ✓/✗ badge here (full result coloring is on the Bracket tab).
      if (team && ctx.sel === team) row.classList.add("mypick");
      const f = team ? flagEl(team) : null;
      if (f) row.appendChild(f);
      const nm = el("span", "bteam" + (team ? "" : " tbd"), team || "TBD");
      if (team) nm.dataset.team = team;
      row.appendChild(nm);
      if (score != null) row.appendChild(el("span", "bscore", String(score)));

      // badge on the picked row: result correctness (on decided games)
      if (team && ctx.sel === team && decided) {
        const ok = ctx.sel === res.winner;
        row.appendChild(el("span", "pickbadge " + (ok ? "ok" : "no"), ok ? "✓" : "✗"));
      }
      if (interactive) row.onclick = () => selectPick(id, team);
      node.appendChild(row);
    });
    if (ctx.locked) {
      node.classList.add("locked");
      const lk = el("span", "node-lock", "🔒");
      lk.title = "Locked — picks frozen";
      node.appendChild(lk);
    }
    return node;
  }

  function renderPicks() {
    const container = $("#picks-rounds");
    container.innerHTML = "";
    const me = currentName();
    const myPicks = (me && state.picks[me]) || {};
    const isCommish = state.adminUnlocked;

    if (isCommish) {
      container.appendChild(el("div", "commish-banner",
        me ? `Commissioner mode: editing picks for “${me}”. You can change locked matches too.`
           : "Commissioner mode on. Type a player's name above to set or change their picks."));
    }

    const scroll = el("div", "bracket-scroll");
    const graph = el("div", "bracket");
    graph.id = "picks-graph";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.classList.add("bracket-lines");
    graph.appendChild(svg);

    let anyEditable = false, unsaved = 0;

    state.bracket.rounds.forEach((round) => {
      const col = el("div", "bcol");
      col.appendChild(el("div", "bcol-head", `${round.name} · ${round.points} pts`));
      const body = el("div", "bcol-body");
      matchIdsByRound(round.key).forEach((id) => {
        const canPick = canEditMatch(id, isCommish);
        if (canPick) anyEditable = true;
        const saved = myPicks[id];
        const pend = state.pending[id];
        const sel = pend != null ? pend : saved;
        const locked = !!state.locks[id];
        if (pend != null && pend !== saved) unsaved++;
        body.appendChild(pickNode(id, { saved, sel, canPick, isCommish, locked }));
      });
      col.appendChild(body);
      graph.appendChild(col);
    });
    scroll.appendChild(graph);
    container.appendChild(scroll);

    if (!anyEditable && !unsaved) {
      container.appendChild(el("p", "hint",
        "No matches are open for picking right now — they're either locked, decided, or their teams aren't set yet."));
    } else {
      const bar = el("div", "record-bar");
      const label = isCommish ? "Save picks for this player" : "Submit my picks";
      const btn = el("button", "btn record-btn", unsaved > 0 ? `${label} (${unsaved} unsaved)` : label);
      btn.onclick = recordPicks;
      bar.appendChild(btn);
      bar.appendChild(el("p", "hint", isCommish
        ? "Click a team to set or replace this player's pick, then Save."
        : "Click your winner in each open match, then Submit. You can change a pick any time until the commissioner locks that match."));
      if (!isCommish && me) {
        const inc = incompleteRounds(me);
        if (inc.length) {
          const msg = inc.map((x) => `${x.round.name} ${x.have}/${x.total}`).join(" · ");
          bar.appendChild(el("p", "incomplete-note", `Pick every game of the round to submit — ${msg}`));
        }
      }
      container.appendChild(bar);
    }

    const tb = me && state.players[me] ? state.players[me].tiebreaker : null;
    $("#tiebreaker-input").value = tb == null ? "" : tb;
    const tbLockedForUser = tiebreakerLocked() && !isCommish;
    $("#tiebreaker-input").disabled = tbLockedForUser;
    $("#save-tiebreaker").disabled = tbLockedForUser;
    const note = $("#tiebreaker-lock");
    if (note) {
      note.hidden = !tiebreakerLocked();
      note.textContent = tiebreakerLocked()
        ? (isCommish ? "🔒 Locked for players (you can still edit)" : "🔒 Locked by the commissioner")
        : "";
    }
    scheduleLines();
  }

  // Identify the player by name only (no PIN). Creates the player if new.
  async function ensurePlayer() {
    const name = currentName();
    if (!name) { toast("Enter your name first.", "error"); return null; }
    if (!sb) { toast("Supabase not configured.", "error"); return null; }
    if (!state.players[name]) {
      const { error } = await sb.from("players").insert({ name, pin: "" });
      if (error) { toast("Could not create player: " + error.message, "error"); return null; }
      state.players[name] = { pin: "", tiebreaker: null };
      refreshRoster();
    }
    return name;
  }

  // Clicking a team selects it locally (highlight). Nothing saves until Submit.
  function selectPick(matchId, team) {
    if (!canEditMatch(matchId, state.adminUnlocked)) {
      toast("That match is locked.", "error");
      return;
    }
    if (state.pending[matchId] === team) delete state.pending[matchId];
    else state.pending[matchId] = team;
    renderPicks();
  }

  // Gather the pending selections the current actor is allowed to save.
  function pendingRows(name) {
    const rows = [];
    Object.keys(state.bracket.matches).forEach((id) => {
      const pend = state.pending[id];
      if (pend == null) return;
      if (!canEditMatch(id, state.adminUnlocked)) return;
      rows.push({ player: name, match_id: Number(id), pick: pend });
    });
    return rows;
  }

  // Submit button: show an inline confirmation (no popup dialog).
  function recordPicks() {
    const name = currentName();
    if (!name) { toast("Select your name first.", "error"); return; }
    const rows = pendingRows(name);
    if (!rows.length) { toast("Pick at least one team first.", "error"); return; }

    // Players must complete every game of a fully-determined round before saving.
    if (!state.adminUnlocked) {
      const inc = incompleteRounds(name);
      if (inc.length) {
        const msg = inc.map((x) => `${x.round.name} (${x.have}/${x.total})`).join(", ");
        toast("Pick every game of the round before submitting: " + msg, "error");
        return;
      }
    }

    const bar = document.querySelector(".record-bar");
    if (!bar) { doRecordPicks(name, rows); return; }
    bar.innerHTML = "";
    const q = state.adminUnlocked
      ? `Save ${rows.length} pick${rows.length === 1 ? "" : "s"} for ${name}?`
      : `${name}, do you confirm your selection?`;
    bar.appendChild(el("p", "confirm-q", q));
    const yes = el("button", "btn record-btn", state.adminUnlocked ? "Yes, save" : "Yes, confirm");
    yes.onclick = () => doRecordPicks(name, rows);
    const cancel = el("button", "btn secondary", "Cancel");
    cancel.onclick = () => renderPicks();
    bar.appendChild(yes);
    bar.appendChild(cancel);
  }

  // Actually persist the picks after confirmation.
  async function doRecordPicks(name, rows) {
    const ensured = await ensurePlayer();
    if (!ensured) return;
    const { error } = await sb.from("picks").upsert(rows, { onConflict: "player,match_id" });
    if (error) { toast("Save failed: " + error.message, "error"); return; }

    const saved = (state.picks[name] = state.picks[name] || {});
    rows.forEach((r) => { saved[r.match_id] = r.pick; delete state.pending[r.match_id]; });
    renderPicks();
    renderStandings();
    toast(`Saved ${rows.length} pick${rows.length === 1 ? "" : "s"} for ${name}.`, "ok");
  }

  async function saveTiebreaker() {
    if (tiebreakerLocked() && !state.adminUnlocked) {
      toast("The tiebreaker is locked — ask the commissioner.", "error");
      return;
    }
    const name = await ensurePlayer();
    if (!name) return;
    const val = $("#tiebreaker-input").value.trim();
    const num = val === "" ? null : Number(val);
    const { error } = await sb.from("players").update({ tiebreaker: num }).eq("name", name);
    if (error) { toast("Save failed: " + error.message, "error"); return; }
    state.players[name].tiebreaker = num;
    toast("Tiebreaker saved.", "ok");
  }

  // ---- STANDINGS tab ----
  function actualTiebreaker() {
    // total goals in semifinals (101,102) + final (103)
    let total = 0, any = false;
    [101, 102, 103].forEach((id) => {
      const r = state.results[id];
      if (r && r.score_a != null && r.score_b != null) {
        total += Number(r.score_a) + Number(r.score_b);
        any = true;
      }
    });
    return any ? total : null;
  }

  function computeScores() {
    const totals = {};
    Object.keys(state.players).forEach((name) => (totals[name] = 0));
    Object.keys(state.picks).forEach((name) => { if (!(name in totals)) totals[name] = 0; });

    Object.keys(state.results).forEach((id) => {
      const res = state.results[id];
      if (!res.winner) return;
      const m = state.bracket.matches[id];
      if (!m) return;
      const pts = state.roundsByKey[m.round].points;
      Object.keys(state.picks).forEach((name) => {
        if (state.picks[name][id] === res.winner) totals[name] += pts;
      });
    });
    return totals;
  }

  function renderStandings() {
    const totals = computeScores();
    const actualTB = actualTiebreaker();
    const rows = Object.keys(totals).map((name) => ({
      name,
      pts: totals[name],
      tb: state.players[name] ? state.players[name].tiebreaker : null
    }));
    rows.sort((x, y) => {
      if (y.pts !== x.pts) return y.pts - x.pts;
      if (actualTB != null && x.tb != null && y.tb != null) {
        return Math.abs(x.tb - actualTB) - Math.abs(y.tb - actualTB);
      }
      return x.name.localeCompare(y.name);
    });

    const tbody = $("#standings-table").querySelector("tbody");
    tbody.innerHTML = "";
    const head = document.createElement("tr");
    head.innerHTML = "<th class='rank'>#</th><th>Player</th><th>Tiebreaker</th><th class='pts'>Points</th>";
    tbody.appendChild(head);

    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td colspan='4' class='hint'>No players yet. Make some picks!</td>";
      tbody.appendChild(tr);
      return;
    }
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      if (i === 0 && r.pts > 0) tr.className = "leader";
      const tbTxt = r.tb == null ? "—" : (actualTB != null ? `${r.tb} (Δ${Math.abs(r.tb - actualTB)})` : r.tb);
      tr.innerHTML =
        `<td class="rank">${i + 1}</td><td>${escapeHtml(r.name)}</td>` +
        `<td class="tb">${tbTxt}</td><td class="pts">${r.pts}</td>`;
      tbody.appendChild(tr);
    });
  }

  // ---- BRACKET tab — true left-to-right bracket with connector lines ----
  function bracketNode(id) {
    const { a, b } = teamsOf(id);
    const res = state.results[id] || {};
    const node = el("div", "bnode");
    node.dataset.match = id;
    [[a, res.score_a], [b, res.score_b]].forEach(([team, score]) => {
      const row = el("div", "brow");
      if (res.winner) row.classList.add(res.winner === team ? "bwin" : "blose");
      const f = team ? flagEl(team) : null;
      if (f) row.appendChild(f);
      const nm = el("span", "bteam" + (team ? "" : " tbd"), team || "TBD");
      if (team) nm.dataset.team = team;
      row.appendChild(nm);
      if (score != null) row.appendChild(el("span", "bscore", String(score)));
      node.appendChild(row);
    });
    return node;
  }

  function renderBracket() {
    const container = $("#bracket-rounds");
    container.innerHTML = "";
    const scroll = el("div", "bracket-scroll");
    const graph = el("div", "bracket");
    graph.id = "bracket-graph";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.id = "bracket-lines";
    svg.classList.add("bracket-lines");
    graph.appendChild(svg);

    state.bracket.rounds.forEach((round) => {
      const col = el("div", "bcol");
      col.appendChild(el("div", "bcol-head", round.name));
      const body = el("div", "bcol-body");
      matchIdsByRound(round.key).forEach((id) => body.appendChild(bracketNode(id)));
      col.appendChild(body);
      graph.appendChild(col);
    });
    scroll.appendChild(graph);
    container.appendChild(scroll);
    scheduleLines();
  }

  // Draw elbow connectors from each match to its two feeder matches, measured
  // from the live layout (so it stays correct on any screen width).
  function drawConnectorsFor(graph) {
    if (!graph) return;
    const svg = graph.querySelector(".bracket-lines");
    if (!svg) return;
    const w = graph.scrollWidth, h = graph.scrollHeight;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const base = graph.getBoundingClientRect();
    const nodeOf = (id) => graph.querySelector(`.bnode[data-match="${id}"]`);
    const geom = (node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left - base.left + graph.scrollLeft,
        right: r.right - base.left + graph.scrollLeft,
        cy: r.top - base.top + graph.scrollTop + r.height / 2
      };
    };
    if (base.width === 0) return; // tab not visible yet

    Object.keys(state.bracket.matches).forEach((id) => {
      const m = state.bracket.matches[id];
      [m.a, m.b].forEach((slot) => {
        if (slot.from == null) return;
        const fe = nodeOf(slot.from), pe = nodeOf(id);
        if (!fe || !pe) return;
        const f = geom(fe), p = geom(pe);
        const busX = (f.right + p.left) / 2;
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", `M ${f.right} ${f.cy} H ${busX} V ${p.cy} H ${p.left}`);
        path.setAttribute("class", "bline");
        svg.appendChild(path);
      });
    });
  }

  function bracketActive() { return $("#tab-bracket").classList.contains("active"); }
  function picksActive() { return $("#tab-picks").classList.contains("active"); }
  function drawAllVisibleConnectors() {
    if (bracketActive()) drawConnectorsFor(document.getElementById("bracket-graph"));
    if (picksActive()) drawConnectorsFor(document.getElementById("picks-graph"));
  }
  function scheduleLines() {
    requestAnimationFrame(() => requestAnimationFrame(drawAllVisibleConnectors));
  }

  // ---- ADMIN tab ----
  function renderAdmin() {
    const wrap = $("#admin-matches");
    wrap.hidden = false;
    wrap.innerHTML = "";

    // --- Player management ---
    wrap.appendChild(el("h3", "admin-section", "Players"));

    // add a new player (inline input — no popup dialogs)
    const addRow = el("div", "admin-row");
    const addInput = document.createElement("input");
    addInput.type = "text"; addInput.placeholder = "New player name"; addInput.className = "grow";
    const addBtn = el("button", "btn", "Add player");
    addBtn.onclick = () => adminAddPlayer(addInput.value);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") adminAddPlayer(addInput.value); });
    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    wrap.appendChild(addRow);

    const names = Object.keys(state.players).sort((a, b) => a.localeCompare(b));
    names.forEach((name) => {
      const nPicks = state.picks[name] ? Object.keys(state.picks[name]).length : 0;
      const row = el("div", "admin-row");
      row.appendChild(el("span", "pair", name));
      row.appendChild(el("span", "hint", `${nPicks} pick${nPicks === 1 ? "" : "s"}`));
      const rename = el("button", "btn secondary", "Rename");
      rename.onclick = () => startRenamePlayer(row, name);
      row.appendChild(rename);
      const del = el("button", "btn danger", "Delete");
      del.onclick = () => startDeletePlayer(row, name);
      row.appendChild(del);
      wrap.appendChild(row);
    });

    // --- Results ---
    wrap.appendChild(el("h3", "admin-section", "Results"));
    Object.keys(state.bracket.matches)
      .sort((x, y) => Number(x) - Number(y))
      .forEach((id) => {
        const { a, b } = teamsOf(id);
        const res = state.results[id] || {};
        const row = el("div", "admin-row");
        row.appendChild(el("span", "num", `#${id}`));
        const pair = el("span", "pair", `${a || "TBD"} vs ${b || "TBD"}`);
        row.appendChild(pair);

        const sa = document.createElement("input");
        sa.type = "number"; sa.min = "0"; sa.placeholder = "A"; sa.value = res.score_a ?? "";
        const sbi = document.createElement("input");
        sbi.type = "number"; sbi.min = "0"; sbi.placeholder = "B"; sbi.value = res.score_b ?? "";

        const sel = document.createElement("select");
        ["", a, b].forEach((opt) => {
          if (opt === "" || opt) {
            const o = document.createElement("option");
            o.value = opt || ""; o.textContent = opt ? `Winner: ${opt}` : "— winner —";
            if (res.winner === opt) o.selected = true;
            sel.appendChild(o);
          }
        });

        const save = el("button", "btn secondary", "Save");
        save.onclick = () => adminSaveResult(id, sel.value, sa.value, sbi.value);

        const locked = !!state.locks[id];
        const lock = el("button", "btn lock-toggle " + (locked ? "is-locked" : "is-open"),
          locked ? "🔒 Locked" : "🔓 Unlocked");
        lock.title = locked ? "Picks are locked for this match. Click to unlock." : "Players can change picks. Click to lock.";
        lock.onclick = () => adminToggleLock(id);

        row.appendChild(sa);
        row.appendChild(sbi);
        row.appendChild(sel);
        row.appendChild(save);
        row.appendChild(lock);
        wrap.appendChild(row);
      });

    // --- Tiebreaker lock ---
    wrap.appendChild(el("h3", "admin-section", "Tiebreaker"));
    const tbRow = el("div", "admin-row");
    tbRow.appendChild(el("span", "pair", "Total goals in semifinals + final"));
    const tbLocked = tiebreakerLocked();
    const tbToggle = el("button", "btn lock-toggle " + (tbLocked ? "is-locked" : "is-open"),
      tbLocked ? "🔒 Locked" : "🔓 Unlocked");
    tbToggle.title = tbLocked ? "Players can't change their guess. Click to unlock." : "Players can change their guess. Click to lock (do this before the semifinals).";
    tbToggle.onclick = adminToggleTiebreakerLock;
    tbRow.appendChild(tbToggle);
    wrap.appendChild(tbRow);
  }

  // Commissioner-only: lock/unlock the tiebreaker guess.
  async function adminToggleTiebreakerLock() {
    if (!state.adminUnlocked) { toast("Unlock admin first.", "error"); return; }
    if (!sb) { toast("Supabase not configured.", "error"); return; }
    const next = !state.locks[TB_LOCK_ID];
    const r = await sb.from("match_locks")
      .upsert({ match_id: TB_LOCK_ID, locked: next }, { onConflict: "match_id" })
      .select();
    if (r.error) { toast("Lock failed: " + r.error.message, "error"); return; }
    if (!r.data || !r.data.length) { toast("Lock blocked by the database (match_locks SQL).", "error"); return; }
    if (next) state.locks[TB_LOCK_ID] = true; else delete state.locks[TB_LOCK_ID];
    renderPicks(); renderAdmin();
    toast(`Tiebreaker ${next ? "locked" : "unlocked"}.`, "ok");
  }

  // Commissioner-only: lock/unlock picks for a single match.
  async function adminToggleLock(id) {
    if (!state.adminUnlocked) { toast("Unlock admin first.", "error"); return; }
    if (!sb) { toast("Supabase not configured.", "error"); return; }
    const next = !state.locks[id];
    const r = await sb.from("match_locks")
      .upsert({ match_id: Number(id), locked: next }, { onConflict: "match_id" })
      .select();
    if (r.error) { toast("Lock failed: " + r.error.message, "error"); return; }
    if (!r.data || !r.data.length) {
      toast("Lock blocked by the database — run the match_locks SQL (see README).", "error");
      return;
    }
    if (next) state.locks[id] = true; else delete state.locks[id];
    renderPicks(); renderAdmin();
    toast(`Match #${id} ${next ? "locked" : "unlocked"}.`, "ok");
  }

  async function adminSaveResult(id, winner, scoreA, scoreB) {
    if (!sb) { toast("Supabase not configured.", "error"); return; }
    const payload = {
      match_id: Number(id),
      winner: winner || null,
      score_a: scoreA === "" ? null : Number(scoreA),
      score_b: scoreB === "" ? null : Number(scoreB)
    };
    const { error } = await sb.from("results").upsert(payload, { onConflict: "match_id" });
    if (error) { toast("Save failed: " + error.message, "error"); return; }
    state.results[id] = { winner: payload.winner, score_a: payload.score_a, score_b: payload.score_b };
    buildGameIndex();
    renderBracket(); renderPicks(); renderStandings(); renderAdmin();
    toast(`Result saved for #${id}.`, "ok");
  }

  // Commissioner-only: delete a player and all of their picks.
  // Inline confirm for deleting a player (no popup dialog).
  function startDeletePlayer(row, name) {
    row.innerHTML = "";
    row.appendChild(el("span", "pair", `Delete ${name} and all their picks?`));
    const yes = el("button", "btn danger", "Yes, delete");
    yes.onclick = () => adminDeletePlayer(name);
    const cancel = el("button", "btn secondary", "Cancel");
    cancel.onclick = () => renderAdmin();
    row.appendChild(yes);
    row.appendChild(cancel);
  }

  async function adminDeletePlayer(name) {
    if (!state.adminUnlocked) { toast("Unlock admin first.", "error"); return; }
    if (!sb) { toast("Supabase not configured.", "error"); return; }

    // Remove picks first, then the player row. .select() returns the rows that
    // were actually deleted — if empty, the DB blocked it (missing delete policy).
    const delPicks = await sb.from("picks").delete().eq("player", name);
    if (delPicks.error) { toast("Delete failed: " + delPicks.error.message, "error"); return; }
    const delPlayer = await sb.from("players").delete().eq("name", name).select();
    if (delPlayer.error) { toast("Delete failed: " + delPlayer.error.message, "error"); return; }
    if (!delPlayer.data || !delPlayer.data.length) {
      toast("Delete blocked by the database — run the delete-permission SQL (see README).", "error");
      return;
    }

    delete state.players[name];
    delete state.picks[name];
    buildGameIndex();
    refreshRoster();
    renderStandings(); renderPicks(); renderAdmin();
    toast(`Deleted ${name}.`, "ok");
  }

  // Commissioner-only: add a new player (name passed from the inline input).
  async function adminAddPlayer(raw) {
    if (!state.adminUnlocked) { toast("Unlock admin first.", "error"); return; }
    if (!sb) { toast("Supabase not configured.", "error"); return; }
    const name = (raw || "").trim();
    if (!name) { toast("Enter a name first.", "error"); return; }
    if (state.players[name]) { toast("A player with that name already exists.", "error"); return; }

    const r = await sb.from("players").insert({ name, pin: "" }).select();
    if (r.error) { toast("Add failed: " + r.error.message, "error"); return; }
    if (!r.data || !r.data.length) { toast("Add blocked by the database (insert policy).", "error"); return; }

    state.players[name] = { pin: "", tiebreaker: null };
    refreshRoster();
    renderAdmin();
    toast(`Added ${name}.`, "ok");
  }

  // Inline rename editor (no popup dialog).
  function startRenamePlayer(row, oldName) {
    row.innerHTML = "";
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = oldName; inp.className = "grow";
    const save = el("button", "btn", "Save");
    save.onclick = () => adminRenamePlayer(oldName, inp.value);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") adminRenamePlayer(oldName, inp.value); });
    const cancel = el("button", "btn secondary", "Cancel");
    cancel.onclick = () => renderAdmin();
    row.appendChild(inp);
    row.appendChild(save);
    row.appendChild(cancel);
    inp.focus();
  }

  // Commissioner-only: rename a player, moving all their picks to the new name.
  // (The picks FK has no ON UPDATE CASCADE, so we create the new row, move the
  // picks, then delete the old row.)
  async function adminRenamePlayer(oldName, raw) {
    if (!state.adminUnlocked) { toast("Unlock admin first.", "error"); return; }
    if (!sb) { toast("Supabase not configured.", "error"); return; }
    const newName = (raw || "").trim();
    if (!newName || newName === oldName) { renderAdmin(); return; }
    if (state.players[newName]) { toast("A player with that name already exists.", "error"); return; }

    const old = state.players[oldName] || { pin: "", tiebreaker: null };
    // 1) create the new player row
    let r = await sb.from("players").insert({ name: newName, pin: old.pin || "", tiebreaker: old.tiebreaker ?? null }).select();
    if (r.error) { toast("Rename failed: " + r.error.message, "error"); return; }
    if (!r.data || !r.data.length) { toast("Rename blocked by the database (insert policy).", "error"); return; }
    // 2) move the picks over
    r = await sb.from("picks").update({ player: newName }).eq("player", oldName);
    if (r.error) { toast("Rename failed moving picks: " + r.error.message, "error"); return; }
    // 3) delete the old player row (its picks have already moved)
    r = await sb.from("players").delete().eq("name", oldName);
    if (r.error) { toast("Rename: couldn't remove old name: " + r.error.message, "error"); return; }

    state.players[newName] = old;
    delete state.players[oldName];
    state.picks[newName] = state.picks[oldName] || {};
    delete state.picks[oldName];
    if (currentName() === oldName) $("#player-name").value = "";
    buildGameIndex();
    refreshRoster();
    renderStandings(); renderPicks(); renderAdmin(); updateCurrentPlayer();
    toast(`Renamed ${oldName} → ${newName}.`, "ok");
  }

  // ---- team game history + hover tooltip ----
  // Merge two sources: the `games` table (group stage + any knockouts the API
  // wrote) and our own knockout `results`. De-dupe by stage + the team pair so
  // a game present in both sources is only counted once.
  function buildGameIndex() {
    const seen = new Set();
    const collected = [];
    const sig = (stage, h, a) =>
      (stage || "") + "|" + [normTeam(h), normTeam(a)].sort().join("|");
    const addGame = (g) => {
      const k = sig(g.stage, g.home, g.away);
      if (seen.has(k)) return;
      seen.add(k);
      collected.push(g);
    };

    // Our own results win first: they're the authoritative, scored source and
    // reflect any manual commissioner entry/correction.
    Object.keys(state.bracket.matches).forEach((id) => {
      const res = state.results[id];
      if (!res || !res.winner || res.score_a == null || res.score_b == null) return;
      const { a, b } = teamsOf(id);
      if (!a || !b) return;
      addGame({
        date: state.bracket.matches[id].kickoff || "",
        stage: ROUND_STAGE[state.bracket.matches[id].round] || "",
        home: a, away: b, hs: res.score_a, as: res.score_b
      });
    });
    // Then the API history fills the rest (group stage + any knockouts we
    // haven't entered). Only FINISHED games — never live/in-progress scores.
    (state.games || []).forEach((row) => {
      if (row.status !== "FINISHED") return;
      if (row.home_score == null || row.away_score == null) return;
      addGame({
        date: row.utc_date || "",
        stage: STAGE_LABEL[row.stage] || row.stage || "",
        home: row.home, away: row.away,
        hs: row.home_score, as: row.away_score
      });
    });

    const idx = {};
    const push = (team, g) => { (idx[normTeam(team)] = idx[normTeam(team)] || []).push(g); };
    collected.forEach((g) => {
      push(g.home, { date: g.date, stage: g.stage, opp: g.away, gf: g.hs, ga: g.as });
      push(g.away, { date: g.date, stage: g.stage, opp: g.home, gf: g.as, ga: g.hs });
    });
    Object.keys(idx).forEach((k) =>
      idx[k].sort((x, y) => (x.date > y.date ? 1 : x.date < y.date ? -1 : 0)));
    state.gamesByTeam = idx;
  }
  function teamHistory(team) { return state.gamesByTeam[normTeam(team)] || []; }

  function fmtDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    return isNaN(dt) ? "" : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function showTooltip(team, x, y) {
    const tip = $("#tooltip");
    tip.innerHTML = "";
    const title = el("div", "tt-title");
    const f = flagEl(team);
    if (f) title.appendChild(f);
    title.appendChild(el("span", null, team));
    tip.appendChild(title);

    const games = teamHistory(team);
    if (!games.length) {
      tip.appendChild(el("div", "tt-empty", "No games recorded yet."));
    } else {
      games.forEach((g) => {
        const r = g.gf > g.ga ? "w" : g.gf < g.ga ? "l" : "d";
        const line = el("div", "tt-game");
        line.appendChild(el("span", "tt-stage", g.stage + (g.date ? " · " + fmtDate(g.date) : "")));
        line.appendChild(el("span", "tt-res " + r, `${g.gf}–${g.ga} vs ${g.opp}`));
        tip.appendChild(line);
      });
    }
    tip.hidden = false;
    positionTooltip(x, y);
  }
  function positionTooltip(x, y) {
    const tip = $("#tooltip");
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function hideTooltip() { $("#tooltip").hidden = true; }
  function setupTooltip() {
    document.addEventListener("mouseover", (e) => {
      const t = e.target.closest && e.target.closest("[data-team]");
      if (t) showTooltip(t.getAttribute("data-team"), e.clientX, e.clientY);
    });
    document.addEventListener("mousemove", (e) => {
      if (!$("#tooltip").hidden) positionTooltip(e.clientX, e.clientY);
    });
    document.addEventListener("mouseout", (e) => {
      const t = e.target.closest && e.target.closest("[data-team]");
      if (t) hideTooltip();
    });
  }

  // ---- misc ----
  // Populate the name dropdown from the roster (only listed players can pick).
  function refreshRoster() {
    const sel = $("#player-name");
    const current = sel.value;
    sel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "— select your name —";
    sel.appendChild(ph);
    Object.keys(state.players).sort((a, b) => a.localeCompare(b)).forEach((n) => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = current && state.players[current] ? current : "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function setupTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        $("#tab-" + btn.dataset.tab).classList.add("active");
        scheduleLines();
      };
    });
    let rT;
    window.addEventListener("resize", () => {
      clearTimeout(rT);
      rT = setTimeout(drawAllVisibleConnectors, 150);
    });
  }

  function updateCurrentPlayer() {
    const n = currentName();
    const badge = $("#current-player");
    if (n) {
      badge.textContent = (state.adminUnlocked ? "✎ editing " : "👤 ") + n;
      badge.classList.toggle("editing", state.adminUnlocked);
      badge.hidden = false;
    } else {
      badge.hidden = true;
      badge.textContent = "";
    }
  }

  // Show/hide the global "Exit commissioner mode" button.
  function updateCommishUI() {
    const b = $("#exit-commish");
    if (b) b.hidden = !state.adminUnlocked;
  }

  function exitCommish() {
    state.adminUnlocked = false;
    $("#admin-pin").value = "";
    const am = $("#admin-matches");
    if (am) { am.hidden = true; am.innerHTML = ""; }
    state.pending = {};
    updateCommishUI();
    renderPicks();
    updateCurrentPlayer();
    toast("Exited commissioner mode.", "ok");
  }

  function setupActions() {
    $("#player-name").addEventListener("change", () => { state.pending = {}; renderPicks(); updateCurrentPlayer(); });
    $("#player-name").addEventListener("blur", () => { renderPicks(); updateCurrentPlayer(); });
    $("#save-tiebreaker").onclick = saveTiebreaker;

    $("#admin-unlock").onclick = () => {
      if ($("#admin-pin").value.trim() === String(cfg.COMMISSIONER_PIN) && cfg.COMMISSIONER_PIN) {
        state.adminUnlocked = true;
        renderAdmin();
        renderPicks();           // reflect commissioner mode on the picks tab
        updateCommishUI();
        updateCurrentPlayer();
        toast("Commissioner mode on — you can edit any player's picks on the Make Picks tab.", "ok");
      } else {
        toast("Wrong commissioner PIN.", "error");
      }
    };
    $("#exit-commish").onclick = exitCommish;
    updateCommishUI();
    updateCurrentPlayer();
  }

  init();
})();
