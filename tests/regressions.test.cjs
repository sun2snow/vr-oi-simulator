'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 浏览器/渲染替身只负责提供接口；业务函数直接加载项目原脚本。
class Vector3 {
  constructor(x = 0, y = 0, z = 0){ this.set(x, y, z); }
  set(x, y, z){ Object.assign(this, { x, y, z }); return this; }
  add(v){ this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v){ this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  lengthSq(){ return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  normalize(){ return this.multiplyScalar(1 / (Math.sqrt(this.lengthSq()) || 1)); }
  multiplyScalar(s){ this.x *= s; this.y *= s; this.z *= s; return this; }
}
function element(){
  const classes = new Set();
  return {
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', value: '', disabled: false,
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle(c, on){ if (on) classes.add(c); else classes.delete(c); }
    },
    appendChild(child){ this.children.push(child); },
    getContext: () => ({ createRadialGradient: () => ({ addColorStop(){} }), fillRect(){} })
  };
}
function newGuard(x = 0, z = -2){
  return {
    group: { position: new Vector3(x, 0, z), rotation: { y: 0 }, scale: { setScalar(s){ this.value = s; } } },
    phase: 0.5, userData: { alive: true, hp: 1, maxHp: 1, speed: 0.7, flank: 1,
      lungeT: 0, lungeCd: 1, stagger: 0 }
  };
}
function fixture(storage = new Map()){
  let now = 0, seq = 0;
  const jobs = new Map(), els = new Map();
  const getEl = id => { if (!els.has(id)) els.set(id, element()); return els.get(id); };
  const schedule = (fn, delay, repeat) => {
    const id = ++seq;
    jobs.set(id, { fn, at: now + delay, repeat });
    return id;
  };
  const ctx = vm.createContext({
    console, newGuard,
    THREE: { Vector3, Vector2: Vector3, Raycaster: class { layers = { enable(){} }; },
      PlaneGeometry: class {}, CanvasTexture: class {} },
    document: { getElementById: getEl, createElement: element },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    performance: { now: () => now },
    setTimeout: (fn, d) => schedule(fn, d, 0), clearTimeout: id => jobs.delete(id),
    setInterval: (fn, d) => schedule(fn, d, d), clearInterval: id => jobs.delete(id),
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    toast(){}, dismissDialogs(){}, openDialog: () => ({}), closeDialog(){},
    spawnBodyDebris(){},
  });
  const run = s => vm.runInContext(s, ctx);
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  for (const file of ['js/core.js', 'js/world.js', 'js/hp.js', 'js/look.js', 'js/ide.js',
    'js/combat.js', 'js/teacher.js', 'js/npc.js', 'js/ending.js', 'js/save.js']) load(file);
  run(`
    const PROBLEM_BY_ID = new Map([1, 2, 3, 4].map(n => {
      const p = { id: 'P' + n, name: 'Test', max: 100, starter: 'int main(){return 0;}' };
      return [p.id, p];
    }));
    const ACHIEVEMENTS = { first_ac: {}, full_score: {}, clean_run: {}, speedrun: {},
      zero_king: {}, wanderer: {}, army: {}, banned: {}, teacher_hit: {} };
    function unlockAch(id){ state.achievements.add(id); }
    let tension = 0, slowMoDlg = null, hitStop = 0;
    function getTension(){ return tension; }
    function beginSlowMo(){} function endSlowMo(){}
    buildSecurityGuard = newGuard;
    updateAllDeskScreens = () => {};
    scheduleDeskScreensUpdate = () => {};
    judgeCode = () => ({ status: 'AC', score: 100, cases: [] });
    scene = { remove(){}, add(){} };
    camera = { position: new THREE.Vector3(), rotation: { set(){} } };
    doorGroup = { rotation: {} };
    doorLightMesh = { visible: false }; doorGlowMesh = { visible: false };
    doorFloorMesh = { visible: false };
    state.started = true;
    state.problems = Array.from(PROBLEM_BY_ID.values()); state.curProb = 'P1';
    state.pos.set(0, 1.65, 0);
    codeArea.value = 'int main(){return 0;}';
    teacher = { group: newGuard(0, -1).group, userData: { mode: 'patrol' },
      armL: { rotation: {} }, armR: { rotation: {} } };
    npcs = [{ group: newGuard().group, userData: { id: 0, state: 'seated' } }];
  `);
  function advance(to){
    while (true){
      let next;
      for (const pair of jobs) if (pair[1].at <= to && (!next || pair[1].at < next[1].at)) next = pair;
      if (!next) break;
      const [id, job] = next;
      now = job.at;
      if (job.repeat) job.at += job.repeat; else jobs.delete(id);
      job.fn();
    }
    now = to;
  }
  return { run, advance, storage, getEl, jobs, ctx,
    snapshot: () => JSON.parse(storage.get('oi_save_v8')) };
}

test('slow judging saves the final score, submit count and achievements', () => {
  const f = fixture();
  f.run('submitCode()');
  f.advance(1200);
  assert.equal(f.snapshot().score.P1, undefined);
  f.advance(2200);
  assert.equal(f.snapshot().score.P1, 100);
  assert.equal(f.snapshot().submitCount.P1, 1);
  assert.ok(f.snapshot().achievements.includes('first_ac'));
  assert.equal(f.getEl('btnSubmit').disabled, false);
});

test('duplicate submission is ignored and an already queued callback cannot write after ending', () => {
  const f = fixture();
  f.run('submitCode(); submitCode()');
  const callback = Array.from(f.jobs.values()).find(j => j.repeat).fn;
  f.run('endContest(true)');
  callback();
  f.advance(3000);
  assert.equal(f.run('state.score.P1'), undefined);
  assert.equal(f.getEl('endScore').textContent, 0);
  assert.equal(f.run('pendingSubmission'), null);
  assert.equal(f.storage.has('oi_save_v8'), false);
});

for (const ending of ['endContest(false)', 'endByGuards()', 'endByBannedWord("ccf")', 'endByTotalVictory()']){
  test(`${ending} cancels judging, reinforcements and saves`, () => {
    const f = fixture();
    f.run('submitCode(); scheduleGuardWave(900); persistSave(); ' + ending);
    f.advance(5000);
    assert.equal(f.run('state.ended'), true);
    assert.equal(f.run('pendingGuardWaves.size'), 0);
    assert.equal(f.run('securityGuards.length'), 0);
    assert.equal(f.run('state.score.P1'), undefined);
    assert.equal(f.storage.has('oi_save_v8'), false);
  });
}

test('wander penalty survives reload and locks the time slider without resetting elapsed time', () => {
  const f = fixture();
  f.run('state.wanderCount = 5; state.warnCount = 5; applyWanderPenalty(); advanceContestTime(3); persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  assert.equal(g.run('state.wanderPenaltyApplied'), true);
  assert.equal(g.run('state.wanderCount'), 5);
  assert.equal(g.run('timeScale'), 30);
  assert.equal(g.run('state.elapsed'), 13890);
  assert.equal(g.getEl('timeSlider').disabled, true);
  assert.equal(g.getEl('timeValue').textContent, '锁定');
  g.run('endContest(true)');
  assert.equal(g.getEl('endTitle').textContent, '成 绩 已 取 消');
});

test('legacy answer saves load, invalid problem IDs are rejected before mutation', () => {
  const f = fixture();
  f.storage.set('oi_save_v8', JSON.stringify({ problems: ['P1','P2','P3','P4'],
    score: { P1: 30 }, elapsed: 150, curProb: 'missing' }));
  assert.equal(f.run('tryLoadSave()'), true);
  assert.equal(f.run('state.totalScore'), 30);
  assert.equal(f.run('state.realElapsed'), 10);
  assert.equal(f.run('state.curProb'), 'P1');
  const before = f.run('JSON.stringify(state)');
  f.storage.set('oi_save_v8', JSON.stringify({ problems: ['P1','P2','P3','missing'], elapsed: 999 }));
  assert.equal(f.run('tryLoadSave()'), false);
  assert.equal(f.run('JSON.stringify(state)'), before);
});

test('combat round-trip preserves enemies, player HP, cooldowns and unspent reinforcements', () => {
  const f = fixture();
  f.run(`
    state.teacherDown = state.hpVisible = true;
    state.guardKills = 40; state.guardsSpawned = 41; state.hp = 2;
    state.worldTime = 25; state.lastDamageAt = 24.8;
    state.guardGraceUntil = 26; state.punchLockUntil = 27; state.defiance = 2;
    state.pos.set(2, 1.65, 3); state.yaw = 0.8; state.pitch = -0.2; tension = 0.6;
    npcs[0].userData.state = 'down';
    const g = newGuard(3, 4); g.userData.hp = 2; g.userData.maxHp = 3;
    g.userData.stagger = 0.3; securityGuards.push(g);
    scheduleGuardWave(900); persistSave();
  `);
  f.advance(300);
  f.run('persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  assert.equal(g.run('teacher'), null);
  assert.equal(g.run('state.guardKills'), 40);
  assert.equal(g.run('state.hp'), 2);
  assert.equal(g.run('state.lastDamageAt'), 24.8);
  assert.equal(g.run('state.punchLockUntil'), 27);
  assert.equal(g.run('state.defiance'), 2);
  assert.equal(g.run('state.pos.z'), 3);
  assert.equal(g.run('yawTarget'), 0.8);
  assert.equal(g.run('getTension()'), 0.6);
  assert.equal(g.run('npcs[0].userData.state'), 'down');
  assert.equal(g.run('securityGuards[0].userData.hp'), 2);
  assert.equal(g.run('securityGuards[0].userData.stagger'), 0.3);
  assert.equal(g.run('securityGuards[0].group.scale.value'), 1.24);
  g.advance(599);
  assert.equal(g.run('state.guardsSpawned'), 41);
  g.advance(600);
  assert.equal(g.run('state.guardsSpawned'), 44); // 40 杀后每波 3 人
  assert.equal(g.run('state.guardKills + aliveGuardCount()'), 44);
});

test('sweep punch persists kills, elite damage and the pending replacement together', () => {
  const f = fixture();
  f.run(`
    state.teacherDown = state.hpVisible = true;
    const elite = newGuard(0, -1); elite.userData.hp = elite.userData.maxHp = 3;
    securityGuards.push(elite, newGuard(0, -1.5)); state.guardsSpawned = 2;
    punchGuardsArc();
  `);
  const saved = f.snapshot().combat;
  assert.equal(saved.guardKills, 1);
  assert.equal(saved.guardsSpawned, 2);
  assert.equal(saved.guards.length, 1);
  assert.equal(saved.guards[0].hp, 2);
  assert.equal(saved.waves.length, 1);
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  g.advance(900);
  assert.equal(g.run('aliveGuardCount()'), 3);
  assert.equal(g.run('state.guardsSpawned'), 4);
});

test('taking damage saves HP and the player-wide invulnerability timestamp', () => {
  const f = fixture();
  f.run(`
    state.teacherDown = state.hpVisible = true;
    state.guardsSpawned = 1; state.worldTime = 10;
    securityGuards.push(newGuard(0, -0.5));
    handleGuardCatch(securityGuards[0]);
  `);
  assert.equal(f.snapshot().combat.hp, 2);
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  g.run('handleGuardCatch(securityGuards[0])');
  assert.equal(g.run('state.hp'), 2);
  g.run('state.worldTime += 1.1; handleGuardCatch(securityGuards[0])');
  assert.equal(g.run('state.hp'), 1);
});

test('saving immediately after hitting the teacher does not lose the initial wave', () => {
  const f = fixture();
  f.run('punchTeacher()');
  assert.equal(f.snapshot().combat.waves.length, 1);
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  g.advance(1499);
  assert.equal(g.run('state.guardsSpawned'), 0);
  g.advance(1500);
  assert.equal(g.run('state.guardsSpawned'), 2);
  assert.equal(g.run('state.hp'), 3);
});

test('reload with no active enemies and a remaining budget cannot deadlock combat', () => {
  const f = fixture();
  f.run('state.teacherDown = state.hpVisible = true; state.guardKills = state.guardsSpawned = 10; persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  g.advance(900);
  assert.equal(g.run('aliveGuardCount()'), 2);
});

test('reinforcements respect the 500-person budget and the final door survives reload', () => {
  const f = fixture();
  f.run('state.teacherDown = state.hpVisible = true; state.guardKills = state.guardsSpawned = 499; scheduleGuardWave(900); persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  g.advance(900);
  assert.equal(g.run('state.guardsSpawned'), 500);
  assert.equal(g.run('aliveGuardCount()'), 1);
  g.run('spawnTwoGuards()');
  assert.equal(g.run('aliveGuardCount()'), 1);
  g.run('securityGuards[0].userData.hp = 1; killGuard(securityGuards[0]); persistSave()');
  const h = fixture(g.storage);
  assert.equal(h.run('tryLoadSave()'), true);
  assert.equal(h.run('state.doorOpen && doorLightMesh.visible'), true);
  assert.equal(h.run('aliveGuardCount()'), 0);
  h.run('walkOutOfTheRoom()');
  assert.equal(h.run('state.ended'), true);
  assert.equal(h.getEl('endTitle').textContent, '无 人 能 挡');
});

test('invalid combat budget is rejected without partially restoring scores', () => {
  const f = fixture();
  f.run('persistSave()');
  const broken = f.snapshot();
  broken.score.P1 = 100; broken.combat.guardsSpawned = 100;
  f.storage.set('oi_save_v8', JSON.stringify(broken));
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), false);
  assert.equal(g.run('state.totalScore'), 0);
  assert.equal(g.run('state.guardsSpawned'), 0);
});

test('long frame intervals are fully counted and real elapsed time ignores speed changes', () => {
  const f = fixture();
  assert.equal(f.run('advanceContestTime(60)'), false);
  assert.equal(f.run('state.elapsed'), 900);
  f.run('timeScale = 30; advanceContestTime(10)');
  assert.equal(f.run('state.elapsed'), 1200);
  assert.equal(f.run('state.realElapsed'), 70);
  f.run('persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  assert.equal(g.run('state.realElapsed'), 70);
  assert.equal(g.run('timeScale'), 30);
  assert.equal(g.run('advanceContestTime(1000)'), true);
  assert.equal(g.run('state.elapsed'), 14400);
  assert.equal(g.run('state.realElapsed'), 510); // 到期即停止累计
});

test('clock does not advance before starting, after ending or for invalid deltas', () => {
  const f = fixture();
  f.run('state.started = false; advanceContestTime(10); state.started = true; state.ended = true; advanceContestTime(10)');
  f.run('state.ended = false; advanceContestTime(NaN); advanceContestTime(-1)');
  assert.equal(f.run('state.elapsed'), 0);
});

test('jump raises camera, lands at normal height and rolls back an obstructed landing', () => {
  const f = fixture();
  f.run('tryJump(); updatePlayer(0.1)');
  assert.ok(f.run('jumpY > 0'));
  assert.ok(f.run('Math.abs(camera.position.y - (1.65 + jumpY + Math.sin(state.bob) * 0.004)) < 1e-9'));
  f.run('state.pos.x = 3; addObstacle(3, 0, 0.5, 0.5); for (let i = 0; i < 10; i++) updatePlayer(0.1)');
  assert.equal(f.run('onGround'), true);
  assert.equal(f.run('state.pos.x'), 0);
  assert.equal(f.run('jumpY'), 0);
  assert.ok(f.run('Math.abs(camera.position.y - (1.65 + Math.sin(state.bob) * 0.004)) < 1e-9'));
});

test('airborne save restores to takeoff point, not inside an obstacle', () => {
  const f = fixture();
  f.run('tryJump(); state.pos.x = 3; persistSave()');
  const g = fixture(f.storage);
  assert.equal(g.run('tryLoadSave()'), true);
  assert.equal(g.run('state.pos.x'), 0);
  assert.equal(g.run('onGround'), true);
});

test('storage failure is reported and clearing a save cancels pending autosave', () => {
  const f = fixture();
  f.run('scheduleAutoSave(); clearSave()');
  f.advance(2000);
  assert.equal(f.storage.has('oi_save_v8'), false);
  f.run('localStorage.setItem = () => { throw new Error("quota"); }');
  assert.equal(f.run('persistSave()'), false);
});
