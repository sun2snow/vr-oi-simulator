'use strict';
/* 版本 2：答题、处罚与保安主线共用一份快照；沿用 key 兼容旧答题存档。 */
const SAVE_KEY = 'oi_save_v8';
const SAVE_VERSION = 2;
let autoSaveTimer = null;

function scheduleAutoSave(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    persistSave();
  }, 1200);
}

function captureCombatSave(){
  // 空中存档落回起跳安全点，避免重载后站进桌子里。
  const pos = onGround ? state.pos : _jumpSafe;
  return {
    teacherDown: state.teacherDown, hp: state.hp, hpVisible: state.hpVisible,
    guardKills: state.guardKills, guardsSpawned: state.guardsSpawned,
    doorOpen: state.doorOpen, defiance: state.defiance,
    worldTime: state.worldTime, lastDamageAt: state.lastDamageAt,
    // 弹窗不序列化；读档相当于收起通报，保留结束后的保护期。
    guardGraceUntil: slowMoDlg
      ? Math.max(state.guardGraceUntil, state.worldTime + GUARD_ALERT_GRACE)
      : state.guardGraceUntil,
    punchLockUntil: state.punchLockUntil, tension: getTension(),
    player: { x: pos.x, z: pos.z, yaw: state.yaw, pitch: state.pitch },
    downNPCs: npcs.filter(n => n.userData.state === 'down').map(n => n.userData.id),
    guards: securityGuards.filter(g => g.userData.alive).map(g => ({
      x: g.group.position.x, z: g.group.position.z, yaw: g.group.rotation.y,
      phase: g.phase, hp: g.userData.hp, maxHp: g.userData.maxHp,
      speed: g.userData.speed, flank: g.userData.flank,
      lungeT: g.userData.lungeT, lungeCd: g.userData.lungeCd,
      stagger: g.userData.stagger
    })),
    waves: Array.from(pendingGuardWaves, w => ({
      delay: Math.max(0, w.due - performance.now()), kind: w.kind
    }))
  };
}

function persistSave(){
  if (!state.started || state.ended) return false;
  try {
    const blob = {
      version: SAVE_VERSION,
      code: state.code, score: state.score, submitCount: state.submitCount,
      curProb: state.curProb, elapsed: state.elapsed, realElapsed: state.realElapsed,
      timeScale, warnCount: state.warnCount, wanderCount: state.wanderCount,
      wanderPenaltyApplied: state.wanderPenaltyApplied,
      achievements: Array.from(state.achievements),
      savedAt: Date.now(), problems: state.problems.map(p => p.id),
      combat: captureCombatSave()
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
    return true;
  } catch(e){ return false; }
}

function savedNumber(value, fallback, min, max){
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/* 在修改任何运行时状态前验证，损坏/不兼容存档不会留下半恢复状态。 */
function validateCombatSave(b){
  if (!b || typeof b !== 'object') throw new Error('Invalid combat save');
  const finiteFields = ['hp', 'guardKills', 'guardsSpawned', 'defiance', 'worldTime',
    'lastDamageAt', 'guardGraceUntil', 'punchLockUntil', 'tension'];
  if (!finiteFields.every(k => Number.isFinite(b[k]))) throw new Error('Invalid combat numbers');
  if (!['teacherDown', 'hpVisible', 'doorOpen'].every(k => typeof b[k] === 'boolean'))
    throw new Error('Invalid combat flags');
  if (!Number.isInteger(b.hp) || b.hp < 1 || b.hp > HP_MAX ||
      !Number.isInteger(b.guardKills) || !Number.isInteger(b.guardsSpawned) ||
      b.guardKills < 0 || b.guardsSpawned > GUARD_MAX_TOTAL ||
      b.worldTime < 0 || b.defiance < 0 || b.tension < 0 || b.tension > 1)
    throw new Error('Invalid combat range');
  if (!b.player || !['x', 'z', 'yaw', 'pitch'].every(k => Number.isFinite(b.player[k])))
    throw new Error('Invalid player');
  if (!Array.isArray(b.guards) || b.guards.length > GUARD_MAX_TOTAL ||
      b.guardKills + b.guards.length !== b.guardsSpawned)
    throw new Error('Invalid guard budget');
  if (b.doorOpen !== (b.guardKills === GUARD_MAX_TOTAL) ||
      (b.teacherDown !== b.hpVisible) || (!b.teacherDown && b.guardsSpawned > 0))
    throw new Error('Invalid combat progression');
  for (const g of b.guards){
    if (!g || !['x', 'z', 'yaw', 'phase', 'hp', 'maxHp', 'speed', 'flank',
        'lungeT', 'lungeCd', 'stagger'].every(k => Number.isFinite(g[k])) ||
        !Number.isInteger(g.hp) || !Number.isInteger(g.maxHp) ||
        g.hp < 1 || g.hp > g.maxHp || g.maxHp > 3 || g.speed <= 0 ||
        ![-1, 1].includes(g.flank)) throw new Error('Invalid guard');
  }
  if (!Array.isArray(b.waves) || b.waves.length > GUARD_MAX_TOTAL ||
      !b.waves.every(w => w && Number.isFinite(w.delay) && w.delay >= 0 &&
        w.delay <= 150000 && ['initial', 'replacement', 'quiet'].includes(w.kind)))
    throw new Error('Invalid reinforcements');
  if (!Array.isArray(b.downNPCs) || !b.downNPCs.every(id =>
      Number.isInteger(id) && npcs.some(n => n.userData.id === id)))
    throw new Error('Invalid NPCs');
}

function normalizeSave(o){
  if (!o || typeof o !== 'object' || (o.version !== undefined && o.version !== SAVE_VERSION))
    throw new Error('Unsupported save version');
  if (!Array.isArray(o.problems) || o.problems.length !== 4 || new Set(o.problems).size !== 4)
    throw new Error('Invalid problems');
  const problems = o.problems.map(id => PROBLEM_BY_ID.get(id));
  if (problems.some(p => !p)) throw new Error('Unknown problem');
  if (o.version === SAVE_VERSION) validateCombatSave(o.combat);
  const wanderCount = Math.floor(savedNumber(o.wanderCount, 0, 0, 100000));
  const penalty = o.wanderPenaltyApplied === true || wanderCount >= 5;
  const speed = penalty ? 30 : savedNumber(o.timeScale, timeScale, 1, 60);
  const elapsed = savedNumber(o.elapsed, 0, 0, CONTEST_LEN);
  const result = {
    problems, curProb: o.problems.includes(o.curProb) ? o.curProb : problems[0].id,
    code: {}, score: {}, submitCount: {}, elapsed,
    realElapsed: savedNumber(o.realElapsed, elapsed / speed, 0, Number.MAX_SAFE_INTEGER),
    warnCount: Math.floor(savedNumber(o.warnCount, 0, 0, 100000)),
    wanderCount, wanderPenaltyApplied: penalty,
    achievements: new Set(Array.isArray(o.achievements)
      ? o.achievements.filter(id => typeof id === 'string' && Object.hasOwn(ACHIEVEMENTS, id)) : [])
  };
  for (const p of problems){
    result.code[p.id] = typeof o.code?.[p.id] === 'string' ? o.code[p.id] : p.starter;
    result.score[p.id] = savedNumber(o.score?.[p.id], 0, 0, p.max);
    result.submitCount[p.id] = Math.floor(savedNumber(o.submitCount?.[p.id], 0, 0, 100000));
  }
  return { state: result, speed, combat: o.version === SAVE_VERSION ? o.combat : null };
}

function restoreCombatSave(b){
  if (!b) return; // 旧存档只含答题记录，不能推断已丢失的战斗信息。
  cancelGuardWaves();
  for (const g of securityGuards) scene.remove(g.group);
  securityGuards.length = 0;
  for (const key of ['teacherDown', 'hp', 'hpVisible', 'guardKills', 'guardsSpawned',
    'doorOpen', 'defiance', 'worldTime', 'lastDamageAt', 'guardGraceUntil', 'punchLockUntil']){
    state[key] = b[key];
  }
  state.pos.set(clamp(b.player.x, -7.5, 7.5), 1.65, clamp(b.player.z, -6.5, 6.5));
  state.yaw = yawTarget = b.player.yaw;
  state.pitch = pitchTarget = clamp(b.player.pitch, -1.35, 1.35);
  jumpY = velY = 0;
  onGround = true;
  state.keys = {};
  tension = b.tension;
  if (state.teacherDown && teacher){
    scene.remove(teacher.group);
    teacher = null;
  }
  for (const n of npcs){
    if (b.downNPCs.includes(n.userData.id)){
      n.userData.state = 'down';
      scene.remove(n.group);
    }
  }
  for (const data of b.guards){
    const g = buildSecurityGuard(data.x, data.z);
    g.group.rotation.y = data.yaw;
    g.phase = data.phase;
    if (data.maxHp > 1) g.group.scale.setScalar(1 + 0.08 * data.maxHp);
    g.userData = { alive: true };
    for (const key of ['hp', 'maxHp', 'speed', 'flank', 'lungeT', 'lungeCd', 'stagger'])
      g.userData[key] = data[key];
    securityGuards.push(g);
  }
  for (const w of b.waves) scheduleGuardWave(w.delay, w.kind);
  // 防御性兜底：旧/异常快照若遗漏了最后一波任务，也不能卡死主线。
  if (state.teacherDown && !state.doorOpen && !securityGuards.length && !pendingGuardWaves.size)
    scheduleGuardWave(900);
  if (state.doorOpen) openTheDoor();
  renderHp();
}

function tryLoadSave(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const restored = normalizeSave(JSON.parse(raw));
    Object.assign(state, restored.state);
    timeScale = restored.speed;
    state.npcProbId = state.problems[Math.floor(Math.random() * state.problems.length)].id;
    restoreCombatSave(restored.combat);
    recalcScore();
    updateAllDeskScreens();
    syncViewUI();
    return true;
  } catch(e){ return false; }
}

function clearSave(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  try { localStorage.removeItem(SAVE_KEY); } catch(e){}
}
