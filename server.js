// 분식팡 '같이 하기' 서버: 정적 파일 + WebSocket 방 관리(최대 4명, 개인전/2:2 팀전).
// 게임 자체는 각자 브라우저에서 돌고, 서버는 방/시드/점수만 중계한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC = /^\/(index\.html|manifest\.json|sw\.js|icons\/[\w.-]+)?$/;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (!PUBLIC.test(p)) { res.writeHead(404); res.end('not found'); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/* ───────── 방 ───────── */
const MAX_PLAYERS = 4, GAME_SEC = 60, MAX_ROOMS = 300;
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => {
  for (let k = 0; k < 50; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(c)) return c;
  }
  return null;
};
const cleanName = s => String(s || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 8) || '손님';
const cleanScore = v => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(0, Math.min(9999999, v)) : 0; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.host = null; this.mode = 'ffa'; this.state = 'lobby';
    this.seed = 0; this.nextId = 1; this.timer = null; this.dirty = false; this.lastScoreSend = 0;
  }
  get alive() { return this.players.filter(p => !p.left); }
  info() {
    return { code: this.code, host: this.host, mode: this.mode, state: this.state,
      players: this.players.map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score, done: p.done, left: p.left })) };
  }
  broadcast(o) { for (const p of this.players) if (!p.left) send(p.ws, o); }
  sendRoom() { for (const p of this.alive) send(p.ws, { t: 'room', you: p.id, ...this.info() }); }
  autoTeams() { this.alive.forEach((p, i) => { p.team = i % 2 ? 'B' : 'A'; }); }
  canStart() {
    const n = this.alive.length;
    if (this.mode === 'team') {
      const a = this.alive.filter(p => p.team === 'A').length, b = this.alive.filter(p => p.team === 'B').length;
      return n === 4 && a === 2 && b === 2;
    }
    return n >= 2;
  }
  start() {
    this.state = 'play'; this.seed = (Math.random() * 2 ** 31) | 0;
    for (const p of this.players) { p.score = 0; p.done = false; }
    this.broadcast({ t: 'start', seed: this.seed, mode: this.mode });
    this.sendRoom();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), (GAME_SEC + 45) * 1000); // 접속 끊김 등 안전장치
  }
  scores() { return this.players.map(p => ({ id: p.id, score: p.score, done: p.done })); }
  pushScores() {
    const now = Date.now();
    if (now - this.lastScoreSend >= 200) { this.lastScoreSend = now; this.dirty = false; this.broadcast({ t: 'scores', players: this.scores() }); }
    else if (!this.dirty) { this.dirty = true; setTimeout(() => { if (this.dirty) { this.dirty = false; this.lastScoreSend = Date.now(); this.broadcast({ t: 'scores', players: this.scores() }); } }, 220); }
  }
  checkDone() { if (this.state === 'play' && this.alive.every(p => p.done)) this.finish(); }
  finish() {
    if (this.state !== 'play') return;
    clearTimeout(this.timer); this.state = 'result';
    const team = this.mode === 'team'
      ? { A: this.players.filter(p => p.team === 'A').reduce((s, p) => s + p.score, 0), B: this.players.filter(p => p.team === 'B').reduce((s, p) => s + p.score, 0) }
      : null;
    this.broadcast({ t: 'result', mode: this.mode, team, players: this.players.map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score, left: p.left })) });
  }
  remove(p) {
    p.left = true;
    const alive = this.alive;
    if (!alive.length) { clearTimeout(this.timer); rooms.delete(this.code); return; }
    if (this.host === p.id) this.host = alive[0].id;
    if (this.state === 'lobby') {
      this.players = this.players.filter(x => x !== p);
      if (this.mode === 'team') this.autoTeams();
    } else if (this.state === 'play') {
      if (alive.length < 2) this.finish(); else this.checkDone();
    }
    this.sendRoom();
  }
}

/* ───────── 접속 ───────── */
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', ws => {
  let room = null, me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'create' || m.t === 'join') {
      if (room) return;
      let r;
      if (m.t === 'create') {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: '지금은 방을 더 만들 수 없어요.' });
        const code = newCode(); if (!code) return send(ws, { t: 'err', msg: '방을 만들지 못했어요.' });
        r = new Room(code); rooms.set(code, r);
      } else {
        r = rooms.get(String(m.code || '').toUpperCase().slice(0, 4));
        if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 다시 확인해 주세요.' });
        if (r.state !== 'lobby') return send(ws, { t: 'err', msg: '이미 게임이 시작된 방이에요.' });
        if (r.alive.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요 (최대 4명).' });
      }
      me = { id: r.nextId++, ws, name: cleanName(m.name), team: 'A', score: 0, done: false, left: false };
      r.players.push(me); room = r;
      if (m.t === 'create') r.host = me.id;
      if (r.mode === 'team') r.autoTeams();
      r.sendRoom();
      return;
    }
    if (!room || !me) return;
    switch (m.t) {
      case 'mode':
        if (room.state === 'lobby' && room.host === me.id && (m.mode === 'ffa' || m.mode === 'team')) {
          room.mode = m.mode; if (m.mode === 'team') room.autoTeams(); room.sendRoom();
        }
        break;
      case 'team':
        if (room.state === 'lobby' && room.mode === 'team' && (m.team === 'A' || m.team === 'B')) { me.team = m.team; room.sendRoom(); }
        break;
      case 'start':
        if (room.state === 'lobby' && room.host === me.id) {
          if (!room.canStart()) return send(ws, { t: 'err', msg: room.mode === 'team' ? '팀전은 4명이 2:2로 나뉘어야 해요.' : '2명 이상 모여야 해요.' });
          room.start();
        }
        break;
      case 'score':
        if (room.state === 'play' && !me.done) { me.score = cleanScore(m.score); room.pushScores(); }
        break;
      case 'done':
        if (room.state === 'play' && !me.done) { me.score = cleanScore(m.score); me.done = true; room.pushScores(); room.checkDone(); }
        break;
      case 'lobby':
        if (room.state === 'result') {
          room.state = 'lobby';
          for (const p of room.players) { p.score = 0; p.done = false; }
          room.players = room.players.filter(p => !p.left);
          if (room.mode === 'team') room.autoTeams();
          room.sendRoom();
        }
        break;
      case 'leave':
        room.remove(me); room = null; me = null;
        break;
    }
  });
  ws.on('close', () => { if (room && me) room.remove(me); room = null; me = null; });
  ws.on('error', () => {});
});
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} });
}, 25000);

server.listen(PORT, () => console.log('분식팡 서버 시작: http://localhost:' + PORT));
