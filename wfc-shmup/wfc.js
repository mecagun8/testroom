/**
 * WFC 무한 스크롤 생성기 — 코어 (렌더러 비의존)
 *
 * 2D 캔버스 버전(index.html)과 3D Three.js 버전(index3d.html)이 공유한다.
 * 이론적 배경과 논문과의 차이는 README.md 참조.
 */

/* ══════════════════════════════════════════════════════════════════════════
   1. 결정론적 난수 (seed → 같은 맵)
   ══════════════════════════════════════════════════════════════════════════ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(a, b) {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (a & 0xffff), 16777619);
  h = Math.imul(h ^ (a >>> 16), 16777619);
  h = Math.imul(h ^ (b & 0xffff), 16777619);
  h = Math.imul(h ^ (b >>> 16), 16777619);
  h ^= h >>> 13;
  return h >>> 0;
}

/* 비트마스크 유틸 — 타일 수 ≤ 31개면 도메인을 int32 하나로 표현 가능.
   논문의 List<Tile> tileOptions 를 비트셋으로 바꾼 것. 교집합/합집합이 1클럭. */
function popcount(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >> 24;
}
const lowestIdx = (m) => 31 - Math.clz32(m);

/* ══════════════════════════════════════════════════════════════════════════
   2. 타일셋 + 인접 규칙

   논문(Tiled Model)의 3x3 위치 시스템을 그대로 차용:
     UL UM UR
     ML MM MR   ← 이름에 구조적 역할을 인코딩
     DL DM DR

   단, 논문은 4방향 리스트를 전부 수작업으로 채워서 상호성(reciprocity)이
   깨지기 쉬웠다(=논문이 인정한 error-prone 지점). 여기서는
   RIGHT / DOWN 두 방향만 선언하고 LEFT / UP 은 자동 유도한다.
       left[t] = { s : t ∈ right[s] }
       up[t]   = { s : t ∈ down[s] }
   → 규칙 비대칭 버그가 구조적으로 불가능해진다.
   ══════════════════════════════════════════════════════════════════════════ */
const TS = (function buildTileset() {
  const names = [
    'V',                                                    // 우주 공간 (범용 커넥터 = 논문의 Grass)
    'RUL','RUM','RUR','RML','RMM','RMR','RDL','RDM','RDR',  // 암석 덩어리 (신축 가능)
    'SUL','SUM','SUR','SML','SMR','SDL','SDM','SDR'         // 스테이션 링 (MM=공백, 3x3 고정)
  ];
  const N = names.length;
  const id = {}; names.forEach((n, i) => id[n] = i);

  // [오른쪽에 올 수 있는 타일, 아래에 올 수 있는 타일]
  const decl = {
    // V 는 자기 자신 + 모든 구조물의 "시작 가장자리"를 받아준다.
    // SMR/SDM 이 포함된 이유: 스테이션 링의 빈 중앙(V)의 오른쪽/아래이기 때문.
    V:   [['V','RUL','RML','RDL','SUL','SML','SDL','SMR'],
          ['V','RUL','RUM','RUR','SUL','SUM','SUR','SDM']],

    // ── 암석: MM 이 상하좌우로 늘어나 임의 크기의 덩어리가 된다
    RUL: [['RUM','RUR'], ['RML','RDL']],
    RUM: [['RUM','RUR'], ['RMM','RDM']],
    RUR: [['V'],         ['RMR','RDR']],
    RML: [['RMM','RMR'], ['RML','RDL']],
    RMM: [['RMM','RMR'], ['RMM','RDM']],
    RMR: [['V'],         ['RMR','RDR']],
    RDL: [['RDM','RDR'], ['V']],
    RDM: [['RDM','RDR'], ['V']],
    RDR: [['V'],         ['V']],

    // ── 스테이션: 논문의 "Mountain/Castle 의 MM 을 Grass 로" 트릭.
    //    중앙이 비어 정확히 3x3 고정 크기의 링 구조물이 된다.
    SUL: [['SUM'], ['SML']],
    SUM: [['SUR'], ['V']],
    SUR: [['V'],   ['SMR']],
    SML: [['V'],   ['SDL']],
    SMR: [['V'],   ['SDR']],
    SDL: [['SDM'], ['V']],
    SDM: [['SDR'], ['V']],
    SDR: [['V'],   ['V']],
  };

  const RIGHT = new Int32Array(N), DOWN = new Int32Array(N);
  const LEFT  = new Int32Array(N), UP   = new Int32Array(N);
  for (const n of names) {
    const [r, d] = decl[n];
    for (const t of r) RIGHT[id[n]] |= 1 << id[t];
    for (const t of d) DOWN[id[n]]  |= 1 << id[t];
  }
  // 역방향 자동 유도 — 여기가 상호성을 보증한다
  for (let s = 0; s < N; s++)
    for (let t = 0; t < N; t++) {
      if (RIGHT[s] & (1 << t)) LEFT[t] |= 1 << s;
      if (DOWN[s]  & (1 << t)) UP[t]   |= 1 << s;
    }

  // 가중치.
  //
  // 주의: 월드 Y가 위로 증가하므로 솔버는 구조물을 "아래에서 위로" 쌓는다.
  // 즉 빈 공간 위에 처음 놓이는 것은 타일아트 기준 아랫줄(D*)이다.
  // → 실제 생성 트리거는 RUL 이 아니라 RDL(좌하단 모서리)이고,
  //   RUL 은 "덮개"라서 높이를 결정한다. (논문은 Y가 아래로 증가해 반대)
  //
  // 나머지 타일은 전파에 의해 강제되므로 가중치가 결과에 거의 영향이 없다.
  // 결국 조절 손잡이는 4개뿐이다:
  const W = new Float32Array(N).fill(1);
  const w = (n, v) => W[id[n]] = v;
  w('V', 100);
  w('RDL', 6);                       // ← 암석 생성 빈도 (밀도 곡선이 곱해짐)
  w('RDM', 9); w('RDR', 3);          // ← 가로: DM 이 클수록 넓은 덩어리
  w('RML', 8); w('RUL', 3);          // ← 세로: ML 이 클수록 높은 덩어리
  w('SDL', 0.9);                     // ← 스테이션 생성 빈도 (희귀 랜드마크)

  // 밀도 곡선을 곱할 대상 = V 를 제외한 모든 구조 타일.
  //
  // RDL 하나만 곱하면 밀도 제어가 새어나간다. RDM 을 고르는 것만으로도
  // 전파가 왼쪽에 RDL 을 채워넣어 결국 덩어리가 생기기 때문이다.
  // 구조 타일 전체에 같은 배율을 곱하면 서로의 비율(=모양)은 그대로 두고
  // "V 대 구조물"의 균형만 움직이므로 밀도만 깔끔히 분리된다.
  const isSpawn = new Uint8Array(N).fill(1);
  isSpawn[id.V] = 0;

  // 렌더링 메타
  const meta = names.map(n => {
    if (n === 'V') return { kind: 'void', pos: '' };
    return { kind: n[0] === 'R' ? 'rock' : 'station', pos: n.slice(1) };
  });

  return { names, N, id, RIGHT, LEFT, UP, DOWN, W, isSpawn, meta,
           FULL: (N === 32 ? -1 : (1 << N) - 1), VMASK: 1 };
})();

function unionOf(mask, table) {
  let r = 0;
  for (let i = 0; i < TS.N; i++) if (mask & (1 << i)) r |= table[i];
  return r;
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 무한 스캔라인 WFC

   폭 W 고정 / 세로 무한. 한 번에 bandH 행을 풀고 commitH 행만 확정한다.
   확정된 행은 동결 → 전파가 그 아래로 내려가지 않음 → 비용 상한 보장.
   ══════════════════════════════════════════════════════════════════════════ */
class InfiniteWFC {
  constructor(width, seed, opts = {}) {
    this.W = width;
    this.seed = seed >>> 0;
    this.bandH  = opts.bandH  || 18;   // 푸는 높이 (lookahead 포함)
    this.commitH= opts.commitH|| 9;    // 실제 확정하는 높이
    this.density= opts.density|| (() => 1);
    this.rows = new Map();
    this.rows.set(0, new Int8Array(this.W));  // y=0 은 전부 V (조용한 시작)
    this.top = 0;
    this.stats = { bands: 0, retries: 0, seams: 0, lastMs: 0, avgMs: 0 };
  }

  /** y행을 얻는다. 없으면 거기까지 생성. */
  row(y) {
    while (this.top < y) this._grow();
    return this.rows.get(y);
  }
  tileAt(x, y) {
    const r = this.row(y);
    return (x < 0 || x >= this.W) ? 0 : r[x];
  }
  /** 화면 밖으로 나간 행 해제 — 무한 생성인데 메모리는 상수 */
  prune(minY) {
    for (const k of this.rows.keys()) if (k < minY) this.rows.delete(k);
  }

  _grow() {
    const t0 = performance.now();
    const anchor = this.rows.get(this.top);

    // ── 방어 1: 시드를 바꿔가며 재시도 (밴드가 작아서 매우 저렴)
    let sol = null;
    for (let a = 0; a < 12 && !sol; a++) {
      if (a) this.stats.retries++;
      sol = this._solve(anchor, mulberry32(hash2(this.seed, this.top * 131 + a)));
    }

    if (sol) {
      for (let r = 1; r <= this.commitH; r++) this.rows.set(this.top + r, sol[r]);
    } else {
      // ── 방어 2: 이음매 폴백. 전부 V 로 리셋한다.
      // 구조물이 평평하게 잘리는 1행짜리 흔적이 남지만 절대 멈추지 않는다.
      this.stats.seams++;
      for (let r = 1; r <= this.commitH; r++)
        this.rows.set(this.top + r, new Int8Array(this.W));
    }
    this.top += this.commitH;

    const ms = performance.now() - t0;
    this.stats.bands++;
    this.stats.lastMs = ms;
    this.stats.avgMs += (ms - this.stats.avgMs) / this.stats.bands;
  }

  /** 밴드 하나를 푼다. 성공하면 Int8Array[] (index 0 = 앵커), 실패하면 null. */
  _solve(anchor, rnd) {
    const W = this.W, H = this.bandH + 1;
    const dom = new Int32Array(W * H).fill(TS.FULL);
    for (let x = 0; x < W; x++) dom[x] = 1 << anchor[x];   // 앵커 행은 동결

    // 초기 전파: 앵커 + 좌우 경계(맵 밖 = V)의 제약을 전체에 퍼뜨린다.
    // 논문의 boundary handling 을 명시적 제약으로 바꾼 것 —
    // "폭 안에 못 들어가는 구조물"을 사후 모순이 아니라 사전에 제거한다.
    const seed = [];
    for (let i = W; i < W * H; i++) seed.push(i);
    if (!this._propagate(dom, seed, H)) return null;

    for (;;) {
      // ── 관측: 최소 엔트로피 (= MRV). 동점은 전부 모아서 랜덤 선택
      let bestC = 99, ties = [];
      for (let i = W; i < W * H; i++) {
        const c = popcount(dom[i]);
        if (c === 0) return null;             // 모순
        if (c === 1) continue;
        if (c < bestC) { bestC = c; ties.length = 0; ties.push(i); }
        else if (c === bestC) ties.push(i);
      }
      if (ties.length === 0) break;           // 전부 확정 → 성공

      const i = ties[(rnd() * ties.length) | 0];
      const worldY = this.top + ((i / W) | 0);
      dom[i] = 1 << this._pick(dom[i], worldY, rnd);
      // 붕괴 결과는 "이웃"을 스택에 넣어야 퍼진다. 자기 자신을 넣으면
      // 이미 확정된 도메인이라 변화가 감지되지 않아 전파가 죽는다.
      const st = [];
      this._pushNeighbors(st, i, H);
      if (!this._propagate(dom, st, H)) return null;
    }

    const out = [];
    for (let r = 0; r < H; r++) {
      const a = new Int8Array(W);
      for (let x = 0; x < W; x++) a[x] = lowestIdx(dom[r * W + x]);
      out.push(a);
    }
    return out;
  }

  /** 가중 랜덤. 밀도 곡선은 "생성 트리거" 타일에만 곱한다. */
  _pick(mask, worldY, rnd) {
    const dens = this.density(worldY);
    let tot = 0; const cand = [];
    for (let i = 0; i < TS.N; i++) {
      if (!(mask & (1 << i))) continue;
      const w = TS.isSpawn[i] ? TS.W[i] * dens : TS.W[i];
      cand.push(i); tot += w; cand.push(w);
    }
    let r = rnd() * tot;
    for (let k = 0; k < cand.length; k += 2) { r -= cand[k + 1]; if (r <= 0) return cand[k]; }
    return cand[cand.length - 2];
  }

  /** 스택 기반 제약 전파 (논문의 Propagate + GetPossibleTilesFromNeighbors). */
  _propagate(dom, stack, H) {
    const W = this.W;
    while (stack.length) {
      const i = stack.pop();
      const r = (i / W) | 0;
      if (r === 0) continue;                  // 앵커 행은 건드리지 않는다
      const x = i % W;

      let d = dom[i];
      // 아래 이웃(항상 존재) — 그 위에 올 수 있는 타일들
      d &= unionOf(dom[i - W], TS.UP);
      // 위 이웃 — 밴드 최상단은 제약 없음(다음 밴드가 이어받음)
      if (r < H - 1) d &= unionOf(dom[i + W], TS.DOWN);
      // 좌우 — 맵 밖은 V 로 취급
      d &= unionOf(x > 0     ? dom[i - 1] : TS.VMASK, TS.RIGHT);
      d &= unionOf(x < W - 1 ? dom[i + 1] : TS.VMASK, TS.LEFT);

      if (d === 0) return false;
      if (d !== dom[i]) { dom[i] = d; this._pushNeighbors(stack, i, H); }
    }
    return true;
  }

  _pushNeighbors(stack, i, H) {
    const W = this.W, r = (i / W) | 0, x = i % W;
    if (x > 0)     stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (r > 1)     stack.push(i - W);   // r=1 의 아래는 동결된 앵커
    if (r < H - 1) stack.push(i + W);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   4. 페이싱 — 스크롤 거리에 따라 밀도를 흔든다.

   순수 WFC 는 균질한 텍스처를 만들 뿐 "리듬"이 없다. 슈팅게임에는
   한산한 구간 / 빽빽한 구간의 교대가 필요하므로, 생성 트리거 타일의
   가중치를 y의 저주파 함수로 변조한다. (= 논문의 "degree of control" 축)
   ══════════════════════════════════════════════════════════════════════════ */
const nearDensity = y =>
  0.10 + 1.7 * Math.pow(0.5 + 0.5 * Math.sin(y * 0.021), 2.2)
       + 0.40 * Math.pow(0.5 + 0.5 * Math.sin(y * 0.0053 + 2.1), 3);
const farDensity = y =>
  0.35 + 1.0 * Math.pow(0.5 + 0.5 * Math.sin(y * 0.012 + 0.7), 2);

export { mulberry32, hash2, popcount, TS, InfiniteWFC, nearDensity, farDensity };
