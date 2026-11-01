'use strict';

// Letras da roda: o alfabeto sem K, Q, W, X, Y e Z (as mais difíceis em português).
const LETTERS = 'ABCDEFGHIJLMNOPRSTUV'.split('');

const DEFAULT_CATEGORIES = [
  'Frutas', 'Animais', 'Países', 'Cidades do Brasil', 'Profissões', 'Nomes de pessoas',
  'Cores', 'Marcas', 'Comidas', 'Bebidas', 'Objetos da cozinha', 'Coisas da escola',
  'Partes do corpo', 'Esportes', 'Instrumentos musicais', 'Filmes', 'Séries', 'Novelas',
  'Desenhos animados', 'Cantores ou bandas', 'Times de futebol', 'Peças de roupa',
  'Coisas que levam na praia', 'Coisas que tem numa festa junina', 'Doces',
  'Verduras e legumes', 'Meios de transporte', 'Coisas que voam', 'Coisas redondas',
  'Coisas que fazem barulho', 'Coisas que têm no banheiro', 'Coisas de supermercado',
  'Palavras em inglês', 'Personagens famosos', 'Super-heróis', 'Jogos e brincadeiras',
  'Lugares para viajar', 'Coisas que a gente perde', 'Coisas geladas', 'Coisas quentes',
  'Xingamentos leves', 'Apelidos carinhosos', 'Desculpas para faltar', 'Hobbies',
  'Coisas que têm na geladeira', 'Coisas de academia', 'Plantas e flores', 'Insetos',
  'Peixes e bichos do mar', 'Comidas típicas brasileiras', 'Coisas que têm no quarto',
  'Aplicativos', 'Verbos', 'Adjetivos para elogiar', 'Coisas que dão medo',
  'Coisas que se faz no fim de semana', 'Ingredientes de pizza', 'Matérias da escola',
  'Coisas que têm no escritório', 'Emoções e sentimentos'
];

const CONTEST_WINDOW_MS = 5000; // tempo para contestar a última palavra
const VOTE_MS = 12000;          // duração da votação
const ROUND_END_MS = 6000;      // pausa entre rodadas
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeKey(s) {
  return stripAccents(s).toUpperCase().replace(/[^A-Z]/g, '');
}
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.players = new Map();
    this.order = [];
    this.hostId = null;
    this.settings = { turnSeconds: 10, targetScore: 5, accelerate: true, useDefault: true, custom: [] };
    this.phase = 'lobby'; // lobby | turn | vote | roundEnd | gameEnd
    this.round = null;
    this.roundNumber = 0;
    this.usedCategories = new Set();
    this.timer = null;
    this.nextAt = null;
    this.roundWinnerId = null;
    this.gameWinnerId = null;
    this.starterIndex = 0;
    this.wordSeq = 0;
    this.notice = null;
    this.lastActivity = Date.now();
  }

  // ---------- utilidades ----------
  changed() {
    this.lastActivity = Date.now();
    this.onChange(this);
  }
  setTimer(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }
  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  connected() {
    return this.order.map(id => this.players.get(id)).filter(p => p && p.connected);
  }
  active() {
    return this.connected().filter(p => !p.eliminated);
  }
  isPlaying() {
    return this.phase === 'turn' || this.phase === 'vote';
  }
  setNotice(text) {
    this.notice = text ? { text, at: Date.now() } : null;
  }
  uniqueName(name, playerId) {
    const base = name;
    let n = 2;
    const taken = candidate => [...this.players.values()]
      .some(p => p.id !== playerId && p.name.toLowerCase() === candidate.toLowerCase());
    while (taken(name)) name = `${base.slice(0, 13)} ${n++}`;
    return name;
  }
  pickHost() {
    const first = this.connected()[0];
    this.hostId = first ? first.id : null;
  }
  nextActive(fromId) {
    const n = this.order.length;
    const start = this.order.indexOf(fromId);
    for (let k = 1; k <= n; k++) {
      const p = this.players.get(this.order[(start + k + n) % n]);
      if (p && p.connected && !p.eliminated) return p;
    }
    return null;
  }

  // ---------- entrada e saída ----------
  join(playerId, rawName, socketId) {
    const name = cleanText(rawName, 16);
    if (!name) return { error: 'Digite um apelido para entrar.' };
    let p = this.players.get(playerId);
    if (p) {
      p.socketId = socketId;
      p.connected = true;
      p.name = this.uniqueName(name, playerId);
    } else {
      if (this.players.size >= MAX_PLAYERS) return { error: `A sala está cheia (máximo de ${MAX_PLAYERS} jogadores).` };
      p = {
        id: playerId,
        name: this.uniqueName(name, playerId),
        score: 0,
        connected: true,
        socketId,
        // quem entra no meio da partida joga a partir da próxima rodada
        eliminated: this.phase !== 'lobby'
      };
      this.players.set(playerId, p);
      this.order.push(playerId);
    }
    const host = this.players.get(this.hostId);
    if (!host || !host.connected) this.hostId = playerId;
    this.changed();
    return { ok: true };
  }

  leave(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p || p.socketId !== socketId) return; // outra aba assumiu este jogador
    if (this.phase === 'lobby') {
      this.players.delete(playerId);
      this.order = this.order.filter(id => id !== playerId);
    } else {
      p.connected = false;
    }
    if (this.hostId === playerId) this.pickHost();

    if (this.phase !== 'lobby' && this.phase !== 'gameEnd' && this.connected().length < MIN_PLAYERS) {
      this.toLobby('A partida foi encerrada porque ficaram menos de 2 jogadores.');
      return;
    }
    if (this.isPlaying() && !p.eliminated) {
      this.eliminate(playerId, 'saiu');
      return;
    }
    if (this.phase === 'vote' && this.checkVoteDone()) return;
    this.changed();
  }

  // ---------- configurações ----------
  updateSettings(playerId, s) {
    if (playerId !== this.hostId) return { error: 'Só o anfitrião pode mudar as regras.' };
    if (this.phase !== 'lobby') return { error: 'As regras só mudam antes da partida.' };
    s = s || {};
    const custom = Array.isArray(s.custom) ? s.custom : [];
    const seen = new Set();
    const cleaned = [];
    for (const c of custom) {
      const t = cleanText(c, 40);
      const key = t.toLowerCase();
      if (t && !seen.has(key)) { seen.add(key); cleaned.push(t); }
      if (cleaned.length >= 60) break;
    }
    this.settings = {
      turnSeconds: clampInt(s.turnSeconds, 5, 30, 10),
      targetScore: clampInt(s.targetScore, 1, 15, 5),
      accelerate: !!s.accelerate,
      useDefault: !!s.useDefault,
      custom: cleaned
    };
    this.changed();
    return { ok: true };
  }
  categoryPool() {
    const pool = [...(this.settings.useDefault ? DEFAULT_CATEGORIES : []), ...this.settings.custom];
    return [...new Set(pool)];
  }

  // ---------- partida ----------
  start(playerId) {
    if (playerId !== this.hostId) return { error: 'Só o anfitrião pode começar.' };
    if (this.phase !== 'lobby') return { error: 'A partida já começou.' };
    if (this.connected().length < MIN_PLAYERS) return { error: 'Chame pelo menos mais um amigo para jogar.' };
    if (this.categoryPool().length === 0) return { error: 'Escolha as categorias prontas ou escreva pelo menos uma categoria.' };
    for (const p of this.players.values()) { p.score = 0; p.eliminated = false; }
    this.roundNumber = 0;
    this.usedCategories.clear();
    this.gameWinnerId = null;
    this.setNotice(null);
    this.startRound();
    return { ok: true };
  }

  startRound() {
    for (const p of this.players.values()) p.eliminated = !p.connected;
    if (this.connected().length < MIN_PLAYERS) {
      this.toLobby('A partida foi encerrada porque ficaram menos de 2 jogadores.');
      return;
    }
    const pool = this.categoryPool();
    let options = pool.filter(c => !this.usedCategories.has(c));
    if (options.length === 0) { this.usedCategories.clear(); options = pool; }
    const category = pick(options);
    this.usedCategories.add(category);
    this.roundNumber++;
    this.round = {
      category,
      used: {},
      words: [],
      currentId: null,
      deadline: null,
      turnTotal: null,
      lastWord: null,
      vote: null,
      resets: 0,
      resetAt: null,
      lastOut: null,
      lastResult: null
    };
    this.roundWinnerId = null;
    this.nextAt = null;
    const act = this.active();
    const starter = act[this.starterIndex % act.length];
    this.starterIndex++;
    this.startTurn(starter.id);
  }

  turnMs() {
    let s = this.settings.turnSeconds;
    if (this.settings.accelerate) {
      s -= Math.floor(Object.keys(this.round.used).length / 5);
      s -= this.round.resets * 2;
    }
    return Math.max(4, s) * 1000;
  }

  startTurn(playerId, ms, total) {
    const r = this.round;
    const duration = ms || this.turnMs();
    this.phase = 'turn';
    r.currentId = playerId;
    r.deadline = Date.now() + duration;
    r.turnTotal = total || duration;
    this.setTimer(duration, () => this.eliminate(playerId, 'tempo'));
    this.changed();
  }

  submit(playerId, raw) {
    const r = this.round;
    if (this.phase !== 'turn' || !r || r.currentId !== playerId) return { error: 'Não é a sua vez.' };
    const word = cleanText(raw, 40);
    if (word.length < 2) return { error: 'A palavra precisa ter pelo menos 2 letras.' };
    if (!/^\p{L}[\p{L} '\-]*$/u.test(word)) return { error: 'Use só letras (espaços e hífen valem).' };
    const letter = stripAccents(word[0]).toUpperCase();
    if (!LETTERS.includes(letter)) return { error: `A letra ${letter} não está na roda.` };
    if (r.used[letter]) return { error: `A letra ${letter} já foi usada com “${r.used[letter].word}”.` };
    const key = normalizeKey(word);
    if (r.words.some(w => w.key === key && w.status !== 'rejeitada')) return { error: 'Essa palavra já apareceu nesta rodada.' };

    const entry = { id: ++this.wordSeq, word, key, letter, by: playerId, status: 'ok', at: Date.now() };
    r.words.push(entry);
    r.used[letter] = { word, by: playerId, wordId: entry.id };
    r.lastWord = { id: entry.id, word, letter, by: playerId, contestUntil: Date.now() + CONTEST_WINDOW_MS };

    // Roda completa: as letras voltam e o tempo encolhe.
    if (Object.keys(r.used).length === LETTERS.length) {
      r.used = {};
      r.resets++;
      r.resetAt = Date.now();
    }
    const next = this.nextActive(playerId);
    this.startTurn(next.id);
    return { ok: true };
  }

  // ---------- contestação e votação ----------
  voters() {
    const r = this.round;
    return this.connected().filter(p => r && r.vote && p.id !== r.vote.author);
  }

  contest(playerId) {
    const r = this.round;
    if (this.phase !== 'turn' || !r) return { error: 'Agora não dá para contestar.' };
    const lw = r.lastWord;
    if (!lw || Date.now() > lw.contestUntil) return { error: 'O tempo para contestar essa palavra acabou.' };
    if (lw.by === playerId) return { error: 'Você não pode contestar a sua própria palavra.' };
    const p = this.players.get(playerId);
    if (!p || !p.connected) return { error: 'Você não está na sala.' };

    const remaining = Math.max(3000, r.deadline - Date.now());
    this.clearTimer();
    r.vote = {
      wordId: lw.id,
      word: lw.word,
      letter: lw.letter,
      author: lw.by,
      contestedBy: playerId,
      votes: { [playerId]: false },
      deadline: Date.now() + VOTE_MS,
      resumeId: r.currentId,
      resumeMs: remaining,
      resumeTotal: r.turnTotal
    };
    r.lastWord = null;
    this.phase = 'vote';
    this.setTimer(VOTE_MS, () => this.finishVote());
    if (!this.checkVoteDone()) this.changed();
    return { ok: true };
  }

  vote(playerId, accept) {
    const r = this.round;
    if (this.phase !== 'vote' || !r || !r.vote) return { error: 'Não há votação agora.' };
    if (!this.voters().some(p => p.id === playerId)) return { error: 'Quem escreveu a palavra não vota.' };
    r.vote.votes[playerId] = !!accept;
    if (!this.checkVoteDone()) this.changed();
    return { ok: true };
  }

  checkVoteDone() {
    const r = this.round;
    if (this.phase !== 'vote' || !r || !r.vote) return false;
    const done = this.voters().every(p => p.id in r.vote.votes);
    if (done) { this.finishVote(); return true; }
    return false;
  }

  finishVote() {
    const r = this.round;
    if (this.phase !== 'vote' || !r || !r.vote) return;
    this.clearTimer();
    const v = r.vote;
    const values = Object.values(v.votes);
    const yes = values.filter(Boolean).length;
    const no = values.length - yes;
    const rejected = no > yes; // empate: a palavra vale
    r.vote = null;
    r.lastResult = { word: v.word, author: v.author, rejected, yes, no, at: Date.now() };

    if (rejected) {
      const entry = r.words.find(w => w.id === v.wordId);
      if (entry) entry.status = 'rejeitada';
      if (r.used[v.letter] && r.used[v.letter].wordId === v.wordId) delete r.used[v.letter];
      const author = this.players.get(v.author);
      if (author && !author.eliminated) {
        author.eliminated = true;
        r.lastOut = { id: author.id, reason: 'contestada', at: Date.now() };
      }
    }
    const act = this.active();
    if (act.length <= 1) { this.endRound(act[0] ? act[0].id : null); return; }

    let resume = this.players.get(v.resumeId);
    if (!resume || !resume.connected || resume.eliminated) resume = this.nextActive(v.resumeId);
    if (!resume) { this.endRound(null); return; }
    const sameTurn = resume.id === v.resumeId;
    this.startTurn(resume.id, sameTurn ? v.resumeMs : undefined, sameTurn ? v.resumeTotal : undefined);
  }

  // ---------- eliminação e fim de rodada ----------
  eliminate(playerId, reason) {
    const r = this.round;
    const p = this.players.get(playerId);
    if (!r || !p || p.eliminated || !this.isPlaying()) return;
    p.eliminated = true;
    r.lastOut = { id: playerId, reason, at: Date.now() };

    const act = this.active();
    if (act.length <= 1) { this.endRound(act[0] ? act[0].id : null); return; }

    if (this.phase === 'vote') {
      if (!this.checkVoteDone()) this.changed();
      return;
    }
    if (r.currentId === playerId) {
      this.startTurn(this.nextActive(playerId).id);
      return;
    }
    this.changed();
  }

  endRound(winnerId) {
    const r = this.round;
    this.clearTimer();
    r.currentId = null;
    r.lastWord = null;
    r.vote = null;
    this.roundWinnerId = winnerId;
    if (winnerId) {
      const w = this.players.get(winnerId);
      w.score++;
      if (w.score >= this.settings.targetScore) {
        this.phase = 'gameEnd';
        this.gameWinnerId = winnerId;
        this.nextAt = null;
        this.changed();
        return;
      }
    }
    this.phase = 'roundEnd';
    this.nextAt = Date.now() + ROUND_END_MS;
    this.setTimer(ROUND_END_MS, () => this.startRound());
    this.changed();
  }

  playAgain(playerId) {
    if (playerId !== this.hostId) return { error: 'Só o anfitrião pode recomeçar.' };
    if (this.phase !== 'gameEnd') return { error: 'A partida ainda não terminou.' };
    this.toLobby(null);
    return { ok: true };
  }

  toLobby(message) {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = null;
    this.nextAt = null;
    this.roundWinnerId = null;
    this.gameWinnerId = null;
    for (const id of [...this.order]) {
      const p = this.players.get(id);
      if (!p.connected) { this.players.delete(id); this.order = this.order.filter(x => x !== id); }
    }
    for (const p of this.players.values()) { p.eliminated = false; p.score = 0; }
    const host = this.players.get(this.hostId);
    if (!host) this.pickHost();
    this.setNotice(message);
    this.changed();
  }

  // ---------- estado público ----------
  publicState() {
    const r = this.round;
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      letters: LETTERS,
      roundNumber: this.roundNumber,
      roundWinnerId: this.roundWinnerId,
      gameWinnerId: this.gameWinnerId,
      nextAt: this.nextAt,
      notice: this.notice,
      players: this.order.map(id => {
        const p = this.players.get(id);
        return { id: p.id, name: p.name, score: p.score, connected: p.connected, eliminated: p.eliminated };
      }),
      round: r && {
        category: r.category,
        used: Object.fromEntries(Object.entries(r.used).map(([l, u]) => [l, { word: u.word, by: u.by }])),
        words: r.words.slice(-60).map(w => ({ id: w.id, word: w.word, letter: w.letter, by: w.by, status: w.status })),
        currentId: r.currentId,
        deadline: r.deadline,
        turnTotal: r.turnTotal,
        lastWord: r.lastWord,
        vote: r.vote && {
          word: r.vote.word,
          letter: r.vote.letter,
          author: r.vote.author,
          contestedBy: r.vote.contestedBy,
          votes: r.vote.votes,
          deadline: r.vote.deadline,
          total: VOTE_MS
        },
        resets: r.resets,
        resetAt: r.resetAt,
        lastOut: r.lastOut,
        lastResult: r.lastResult,
        contestWindow: CONTEST_WINDOW_MS
      },
      serverNow: Date.now()
    };
  }
}

module.exports = { Room, LETTERS, DEFAULT_CATEGORIES };
