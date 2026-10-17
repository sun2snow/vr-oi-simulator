'use strict';
/* =========================================================
   combat —— 殴打老师 / 保安 AI / 全员收尾
   （自 index.html 内联脚本拆出）
   ========================================================= */
/* =========================================================
   打老师 / 打保安
   ========================================================= */
/* 增援任务显式登记，读档可恢复剩余等待时间，结局可统一取消。 */
const pendingGuardWaves = new Set();

function scheduleGuardWave(delay, kind = 'replacement'){
  const wave = { due: performance.now() + delay, kind, timer: null };
  pendingGuardWaves.add(wave);
  wave.timer = setTimeout(() => {
    if (!pendingGuardWaves.delete(wave) || state.ended) return;
    spawnTwoGuards();
    if (kind === 'initial') toast('\u26A0 两名保安从门口冲了进来！', 2600);
    else if (kind === 'replacement') toast('门口又冲进来一批替补保安……', 1700);
    audio.beep(kind === 'initial' ? 140 : 200, 0.3, 0.06, 'sawtooth');
    persistSave();
  }, delay);
}

function cancelGuardWaves(){
  for (const wave of pendingGuardWaves) clearTimeout(wave.timer);
  pendingGuardWaves.clear();
}

function punchTeacher(){
  if (state.view !== 'world' || state.ended || state.frozen) return;
  if (!teacher || teacher.userData.leaving) return;
  teacher.userData.leaving = true;

  const d = Math.hypot(state.pos.x - teacher.group.position.x,
                       state.pos.z - teacher.group.position.z);
  if (d > 2.4){
    teacher.userData.leaving = false;
    toast('你离监考老师太远了。', 1400);
    return;
  }
  /* 同样受视角扇形窗口约束 */
  if (!inAttackArc(teacher.group.position.x, teacher.group.position.z)){
    teacher.userData.leaving = false;
    toast('你一拳打向了空气——对准老师再来。', 1300);
    return;
  }

  const dx = state.pos.x - teacher.group.position.x;
  const dz = state.pos.z - teacher.group.position.z;
  teacher.group.rotation.y = Math.atan2(dx, dz);
  teacher.armL.rotation.x = -1.4;
  teacher.armR.rotation.x = -1.4;

  audio.punch();

  /* 打击感：全身部件爆散 + 视角回弹 + 命中顿帧 */
  spawnBodyDebris(teacher.group, { speed: 3.2 });
  kickView(0.045, (Math.random() - 0.5) * 0.05);
  hitStop = 0.07;

  toast('\u{1F44A} 你一拳打在了监考老师的胳膊上……', 1600);
  unlockAch('teacher_hit');
  /* 监考已倒：从这一刻起同学也可以打了 */
  state.teacherDown = true;
  /* 亮出血条 */
  revealHp();
  scheduleGuardWave(1500, 'initial');
  persistSave();

  setTimeout(() => {
    if (state.ended) return;
    if (teacher){
      scene.remove(teacher.group);
      teacher = null;
    }
    toast('监考老师夺门而出，叫来了保安！', 2200);
    audio.beep(880, 0.15, 0.05, 'sawtooth');
    audio.beep(440, 0.25, 0.05, 'sawtooth');
  }, 800);
}

/* ---------- 攻击判定窗口 ----------
   距离之外再加视角扇形：只有落在准星前 GUARD_PUNCH_ARC 弧度内的
   目标才算"在拳范围内"。半角 0.9rad ≈ 51°，比 360° 球判定收紧很多。 */
const GUARD_PUNCH_ARC = 0.4;

function inAttackArc(x, z){
  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  const tx = x - state.pos.x, tz = z - state.pos.z;
  const len = Math.hypot(tx, tz);
  if (len < 1e-4) return true;                 // 贴身也算
  return (fx * tx + fz * tz) / len > Math.cos(GUARD_PUNCH_ARC);
}

/* 统计当前拳范围内（距离 + 扇形）的活保安 */
function guardsInPunchRange(){
  const out = [];
  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const d = Math.hypot(state.pos.x - g.group.position.x,
                         state.pos.z - g.group.position.z);
    if (d <= GUARD_PUNCH_RANGE + 0.3 &&
        inAttackArc(g.group.position.x, g.group.position.z)) out.push(g);
  }
  return out;
}

/* 用引用而非索引：避免数组被 prune 后索引错位 */
/* 击倒单个保安（扫拳的单元）。返回 false 表示最后一名已倒下、终局门已打开。 */
function killGuard(g){
  if (!g || !g.userData.alive) return true;
  /* 多血保安：吃一拳只被打退并僵直，不倒下 */
  if (g.userData.hp > 1){
    g.userData.hp--;
    g.userData.stagger = 0.45;
    const dx = g.group.position.x - state.pos.x;
    const dz = g.group.position.z - state.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const kx = g.group.position.x + dx / len * 1.2;
    const kz = g.group.position.z + dz / len * 1.2;
    if (!collides(kx, g.group.position.z, 0.3)) g.group.position.x = kx;
    if (!collides(g.group.position.x, kz, 0.3)) g.group.position.z = kz;
    return true;
  }
  g.userData.alive = false;
  /* 先炸散再移除组：部件已摘到场景里，带物理飞走 */
  spawnBodyDebris(g.group, { speed: 3.9 });
  scene.remove(g.group);
  state.guardKills++;
  if (state.guardKills >= GUARD_MAX_TOTAL){
    openFinalDoor();
    return false;
  }
  return true;
}

/* 打完全部保安：不直接结算，开门 + 弹"警告"，等玩家自己走出去 */
function openFinalDoor(){
  if (state.doorOpen || state.ended) return;
  openTheDoor();
  audio.beep(880, 0.3, 0.06, 'sine');
  setTimeout(() => audio.beep(1320, 0.4, 0.05, 'sine'), 260);
  toast('走廊尽头那扇门，开了。', 3000);
  /* 慢放 0.4s 再弹窗，让开门的动作先被看见 */
  setTimeout(() => {
    if (state.ended) return;
    openDialog({
      title: '\u26A0 警告',
      text: '门开了。\n\n' +
            '不是考场这一扇——是走廊尽头那扇从来打不开的门。\n' +
            '它开的时候没有声音，只有光。白得不像这个考场里该有的东西。\n\n' +
            '保安们停下了动作，齐刷刷望向那个方向，然后让开了路。\n' +
            '广播里只剩电流噪音。你听见过这样的召唤吗？',
      options: [{ label: '去看看', cb: dlg => closeDialog(dlg) }]
    });
  }, 1400);
}

/* 真的走出白光：此时才结算 */
function walkOutOfTheRoom(){
  if (state.ended) return;
  endByTotalVictory();
}

/* 一拳扫倒拳范围内所有保安（不是只有一个） */
function punchGuardsArc(){
  if (state.worldTime < (state.punchLockUntil || 0)){
    toast('你刚答应过要配合……', 900);
    return;
  }
  const victims = guardsInPunchRange();
  if (!victims.length){
    toast('你的拳头抡了个空。', 1100);
    return;
  }

  let n = 0, tough = 0;
  for (const g of victims){
    const wasHp = g.userData.hp;
    if (!killGuard(g)){ n++; break; }     // 最后一名倒下，等待玩家走出终局门
    if (wasHp > 1) tough++; else n++;
  }
  if (tough && !n && !state.ended){
    audio.punch();
    kickView(0.04, (Math.random() - 0.5) * 0.05);
    hitStop = 0.06;
    toast('\u{1F6E1} 这个保安很结实，只被打退了！', 1300);
    persistSave();
    return;
  }
  if (state.ended) return;

  /* 打击感：视角回弹 + 顿帧（比打老师更重），多杀更猛 */
  audio.punch();
  kickView(0.06, (Math.random() - 0.5) * 0.06);
  hitStop = 0.09 + Math.min(0.06, n * 0.02);

  toast(n > 1 ? `\u{1F44A} 一拳放倒了 ${n} 名保安！` : '\u{1F44A} 一拳撂倒了一个保安！', 1500);
  checkGuardKillMilestones(state.guardKills);
  /* 一整拳只掷一次警告，避免连杀弹出一堆面板 */
  maybeGuardWarning();

  /* 每倒一名补一批，错开进场避免叠在一起 */
  for (let i = 0; i < n && guardPoolRemaining() > 0; i++){
    scheduleGuardWave(900 + i * 260, i === 0 ? 'replacement' : 'quiet');
  }
  persistSave();
}

/* =========================================================
   保安 AI + 碰撞
   ========================================================= */
function updateGuards(realDt, t){
  if (state.ended || state.frozen || state.view !== 'world') return;

  let minDist = Infinity;
  nearestGuardDist = Infinity;
  /* 距离最近的两名保安：用于挂载红色警灯（点光源有上限） */
  const near = [null, null];
  const nearD = [Infinity, Infinity];

  for (let i = 0; i < securityGuards.length; i++){
    const g = securityGuards[i];
    if (!g.userData.alive) continue;

    const pos = g.group.position;
    const dx = state.pos.x - pos.x;
    const dz = state.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < minDist) minDist = d;

    if (d < nearD[0]){ nearD[1] = nearD[0]; near[1] = near[0]; nearD[0] = d; near[0] = g; }
    else if (d < nearD[1]){ nearD[1] = d; near[1] = g; }

    if (d < GUARD_HIT_RADIUS){
      if (!handleGuardCatch(g)) return;
    }

    const ud = g.userData;
    if (slowMoDlg){
      /* 通报弹窗期间：保安原地待命，不会逼近 */
    } else if (ud.stagger > 0){
      ud.stagger -= realDt;                 /* 僵直中：原地不动 */
    } else if (d > 0.01){
      /* 合围：远处斜向包抄（左右各半），近处直扑 */
      const ang = ud.flank * Math.min(1, Math.max(0, (d - 1.8) / 5)) * 0.8;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let ux = dx / d, uz = dz / d;
      let vx = ux * ca - uz * sa, vz = ux * sa + uz * ca;
      /* 互相分开，避免叠成一团 */
      for (let j = 0; j < securityGuards.length; j++){
        if (j === i) continue;
        const o = securityGuards[j];
        if (!o.userData.alive) continue;
        const ox = pos.x - o.group.position.x, oz = pos.z - o.group.position.z;
        const od = Math.hypot(ox, oz);
        if (od > 0.001 && od < 0.9){ vx += ox / od * (0.9 - od); vz += oz / od * (0.9 - od); }
      }
      const vl = Math.hypot(vx, vz) || 1;
      vx /= vl; vz /= vl;
      /* 突进：进入 2.8m 后短暂冲刺 */
      ud.lungeCd -= realDt;
      if (ud.lungeT > 0) ud.lungeT -= realDt;
      else if (d < 2.8 && d > GUARD_HIT_RADIUS && ud.lungeCd <= 0){
        ud.lungeT = 0.3; ud.lungeCd = 2.2 + Math.random();
      }
      const sp = ud.speed * (ud.lungeT > 0 ? 2.6 : 1) * realDt;
      const nx = pos.x + vx * sp;
      const nz = pos.z + vz * sp;
      if (!collides(nx, pos.z, 0.3)) pos.x = nx;
      if (!collides(pos.x, nz, 0.3)) pos.z = nz;
      g.group.rotation.y = Math.atan2(dx, dz);
    }

    const v = Math.sin(t * 3.5 + g.phase) * 0.25;
    g.armL.rotation.x = -0.25 + v;
    g.armR.rotation.x = -0.25 - v;
    g.head.rotation.y = Math.sin(t * 2 + g.phase) * 0.25;

    if (g.warnLight){
      const blink = 0.5 + 0.5 * Math.sin(t * 6 + g.phase);
      g.warnLight.material.color.setRGB(1, blink * 0.4, blink * 0.4);
      g.userData.blink = blink;
    }
    if (g.glow){
      /* 加法光晕跟着闪烁，紧张态下更亮更大 */
      const b = g.userData.blink || 0;
      const tn = getTension();
      g.glow.material.opacity = 0.16 + 0.42 * b + 0.30 * tn;
      g.glow.scale.setScalar(1 + 0.5 * b + 0.6 * tn);
    }
  }

  /* 红色警灯挂到最近的两名保安头顶（无保安时强度归零） */
  updateGuardLights(near, getTension());
  nearestGuardDist = minDist;
}

/* 最近活保安的距离（供紧张值系统读取；无保安为 Infinity） */
let nearestGuardDist = Infinity;

function endByGuards(){
  if (state.ended) return;
  state.ended = true;
  hideAllPanels();
  for (const g of securityGuards) scene.remove(g.group);
  securityGuards.length = 0;

  audio.beep(110, 0.5, 0.08, 'sawtooth');
  audio.beep(80, 0.7, 0.06, 'sawtooth');

  $('endTitle').textContent = '被 保 安 抓 走';
  $('endSub').textContent = '两名保安一左一右架住了你，你被拖出了考场。';
  showEnding(0, '你在考场上公然殴打监考老师，性质恶劣。\n' +
    '本次比赛成绩作废，并记入诚信档案。\n\n' +
    '遵守考场纪律，人人有责。\n下次别再打老师了。');
}

/* 保安抓住玩家：有血条就扣 1 格，没有血条直接结局。
   受击无敌改为玩家侧 1 秒：任何保安都能抓，但玩家 1 秒内只掉一格。
   返回 false 表示本局已经结束。 */
function handleGuardCatch(g){
  const now = state.worldTime;    /* 用世界时钟：慢放期间受击间隔同样被拉长 */
  /* 回应通报期间 + 通报结束后的缓冲期内，保安无法动手 */
  if (slowMoDlg || now < (state.guardGraceUntil || 0)) return true;
  if (state.hpVisible && state.hp > 0){
    if (now - state.lastDamageAt < PLAYER_HURT_INVULN / 1000) return true;
    state.lastDamageAt = now;
    if (!damagePlayer(g, now)){
      endByGuards();
      return false;
    }
    return true;
  }
  endByGuards();
  return false;
}

/* =========================================================
   击杀里程碑 + 保安警告窗
   ---------------------------------------------------------
   - 击杀 10 / 20 / 50 / 100 解锁对应成就；
   - 从第 10 杀起，每次击杀有 GUARD_WARN_CHANCE 概率弹出保安队
     警告窗（3D 悬浮弹窗，必须交互消除）。文案按击杀数分四档，
     语气逐渐升级：口头提醒 → 正式警告 → 纪律处理 → 最后通牒；
   - 选项：一个"配合"与两条随机叛逆台词。配合：违抗计数清零、
     不加派保安，代价是 2 秒内不能出拳；嘴硬：违抗计数 +1（直接
     推高紧张值，见 tension.js）并立刻叫来更多保安；
   - 通报期间保安原地待命且无法伤人；结束后有 GUARD_ALERT_GRACE
     秒的保护期，并把贴身保安推出 GUARD_ALERT_CLEAR 半径之外。
   ========================================================= */
const GUARD_WARN_MIN_KILLS = 10;   // 从第几杀开始可能弹窗
const GUARD_WARN_CHANCE    = 0.1; // 每次击杀的触发概率

const GUARD_WARN_LINES = [
  /* 档 0（10-19）：口头提醒 */
  [
    '同学，请停止攻击工作人员，配合我们维护考场秩序。',
    '保安同志正在赶来。请你放下拳头，我们可以当作什么都没发生。',
    '考场监控已全程记录。现在停手，还来得及。',
    '同学，打人不能加分。有话好好说，先放下手。'
  ],
  /* 档 1（20-49）：正式警告 */
  [
    '最后一次警告。继续袭击工作人员，我们将按考场纪律处理你。',
    '你的行为已构成扰乱考试秩序，我们有权取消你的成绩。',
    '考场秩序由我们负责，你的拳头不负责。立刻停手。',
    '再说一次：放下拳头。这是通知，不是请求。'
  ],
  /* 档 2（50-99）：纪律处理 */
  [
    '拒不配合者，我们有权取消成绩并禁赛三年。这是正式通知。',
    '你已经打倒了足够多的工作人员。收手，或者承担后果。',
    '考场外已经叫好了人。你要继续，我们就只能继续。',
    '《NOI 竞赛纪律》第三十一条：你现在每挥一拳，都在给自己记一笔。'
  ],
  /* 档 3（100+）：最后通牒 */
  [
    '现在立刻双手抱头蹲下，放弃抵抗，否则我们将动用物理。',
    '最后一次。抱头，蹲下，别逼我们把这考场拆了。',
    '你是考生，不是选手队。停下，或者我们让你停下。',
    '给你十秒。之后发生的事情，写在通报里会很难看。'
  ]
];

const GUARD_WARN_DEFY = ['那就试试', '我才不呢', '有本事来抓我啊',
                         '等我先把这题写完', '你们人多了不起？'];

/* 纯函数：按击杀数选警告档位（0=口头提醒 … 3=最后通牒） */
function guardWarnTier(kills){
  if (kills < 20)  return 0;
  if (kills < 50)  return 1;
  if (kills < 100) return 2;
  return 3;
}

/* 纯函数：本次是否触发警告窗 */
function guardWarnRoll(kills, rng){
  if (kills < GUARD_WARN_MIN_KILLS) return false;
  return rng() < GUARD_WARN_CHANCE;
}

function checkGuardKillMilestones(k){
  if (k >= 5)   unlockAch('guard_5');
  if (k >= 10)  unlockAch('guard10');
  if (k >= 20)  unlockAch('guard20');
  if (k >= 50)  unlockAch('guard50');
  if (k >= 100) unlockAch('guard100');
}

/* 通报结束：给玩家缓冲期，并把贴身保安推开，避免一恢复速度就挨打 */
const GUARD_ALERT_GRACE = 1.5;     // 通报结束后的保护时间（世界秒）
const GUARD_ALERT_CLEAR = 1.8;     // 结束时把此半径内的保安推到圈外

function endGuardAlert(dlg){
  endSlowMo();
  closeDialog(dlg);
  state.guardGraceUntil = state.worldTime + GUARD_ALERT_GRACE;
  for (const g of securityGuards){
    if (!g.userData.alive) continue;
    const dx = g.group.position.x - state.pos.x;
    const dz = g.group.position.z - state.pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= GUARD_ALERT_CLEAR) continue;
    const ux = d > 0.01 ? dx / d : 1, uz = d > 0.01 ? dz / d : 0;
    const nx = state.pos.x + ux * GUARD_ALERT_CLEAR;
    const nz = state.pos.z + uz * GUARD_ALERT_CLEAR;
    if (!collides(nx, g.group.position.z, 0.3)) g.group.position.x = nx;
    if (!collides(g.group.position.x, nz, 0.3)) g.group.position.z = nz;
  }
}

function maybeGuardWarning(){
  if (!guardWarnRoll(state.guardKills, Math.random)) return;

  /* 通报弹出：整个世界放慢到 0.1x（考试计时不受影响），
     选项落地后恢复原速 */
  beginSlowMo();

  const lines = GUARD_WARN_LINES[guardWarnTier(state.guardKills)];
  const line = lines[Math.floor(Math.random() * lines.length)];
  /* 两条不重复的叛逆台词 + 一个配合选项 */
  const pool = GUARD_WARN_DEFY.slice();
  const defyA = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const defyB = pool[Math.floor(Math.random() * pool.length)];

  slowMoDlg = openDialog({
    title: '\u26A0 保安队通报 · 已击倒 ' + state.guardKills + ' 人',
    text: line,
    options: [
      {
        label: '好，我配合',
        cb: dlg => cooperateGuardWarning(dlg)
      },
      {
        label: defyA,
        cb: dlg => defyGuardWarning(dlg)
      },
      {
        label: defyB,
        cb: dlg => defyGuardWarning(dlg)
      }
    ]
  });
}

/* 配合：违抗计数清零，不再加派保安；代价是 2 秒内不能出拳 */
function cooperateGuardWarning(dlg){
  endGuardAlert(dlg);
  state.defiance = 0;
  state.punchLockUntil = state.worldTime + 2;
  persistSave();
  toast('你放下了拳头。保安们没有放松，依旧盯着你。', 2200);
}

/* 嘴硬的代价：违抗计数 +1（推高紧张值）+ 立刻叫来更多保安 */
function defyGuardWarning(dlg){
  endGuardAlert(dlg);
  state.defiance = (state.defiance || 0) + 1;
  toast('对面沉默了两秒——然后更多脚步声涌了进来。', 2200);
  audio.beep(180, 0.25, 0.06, 'sawtooth');
  spawnTwoGuards();
  persistSave();
}

/* =========================================================
   主线终局 · 一人军队（击倒全部 500 名保安）
   ========================================================= */
function endByTotalVictory(){
  if (state.ended) return;
  state.ended = true;
  hideAllPanels();
  for (const g of securityGuards) scene.remove(g.group);
  securityGuards.length = 0;
  unlockAch('army');

  $('endTitle').textContent = '无 人 能 挡';
  $('endSub').textContent = '第 500 名保安倒下了。然后，你走进了那片白光。';
  showEnding(state.totalScore,
    '门在身后合上。没有风，没有声音，也没有人追出来。\n\n' +
    '你站在光里回头看：五百具叠在一起的制服，帽檐、徽章、对讲机散了一地。\n' +
    '监考老师不知什么时候已经跑了，教务处的电话打到了天亮。\n' +
    '来的人不认识你，只认识这个考场。他们后来把整层楼封了，\n' +
    '只在记录里写：那个考生赢了，然后走了。\n\n' +
    '《NOI 竞赛纪律》最后一页写着：\n' +
    '“纪律需要人来执行。如果执行纪律的人都不够了，\n' +
    '那考场里就只剩下一条纪律：别惹写代码的人。”\n\n' +
    '主线通关 · 一人军队　　击倒保安 500 / 500');
}

function hideAllPanels(){
  // 所有结局共用出口：取消异步写回/增援，并清除本局存档。
  cancelSubmission();
  cancelGuardWaves();
  clearSave();
  /* 3D 悬浮弹窗也要收场（弹窗不再是 DOM，无法用 classList 隐藏） */
  dismissDialogs();
  ['hud', 'pauseMenu', 'codeUI', 'paperUI', 'corridorUI',
   'bathroomUI', 'npcComputerUI', 'minimapWrap']
    .forEach(id => { const e = $(id); if (e) e.classList.add('hidden'); });
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
}
