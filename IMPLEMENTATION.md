# 구현 레퍼런스

**이 문서의 범위** — `wfc.js` 를 **만질 때** 필요한 것만 담습니다.
API 표면, 깨면 안 되는 불변조건, 타일 추가 절차, 검증 스크립트.

**왜 이렇게 설계했는지**(논문과의 차이, 밴드 스캔라인의 근거, 측정 결과,
알려진 한계, 충돌 레이어 확장 방향)는 [README.md](./README.md) 에 있습니다.
같은 사실을 두 곳에 적지 않았으니, 배경이 필요하면 그쪽을 보세요.

---

## 1. 파일과 책임 경계

```
wfc.js       솔버. 렌더러를 전혀 모른다. Int8Array 격자만 뱉는다.
index.html   3D 뷰 (Three.js) + 터치 조작 + WFC 연산 시각화 패널
2d.html      2D 캔버스 뷰
vendor/      three.js 0.185 (MIT)
```

**핵심 규칙: 뷰가 솔버를 수정하지 않는다.** WFC 격자가 유일한 진실이고
메시·픽셀은 매 프레임 다시 그려지는 표현일 뿐입니다.

> ⚠️ `wfc.js` 는 `index.html` 과 `2d.html` 이 **공유**합니다.
> 여기를 고치면 양쪽이 동시에 영향받습니다. 반드시 둘 다 확인하세요.

---

## 2. `wfc.js` API

### exports

```js
import { InfiniteWFC, TS, nearDensity, farDensity,
         mulberry32, hash2, popcount } from './wfc.js';
```

| 이름 | 용도 |
|---|---|
| `InfiniteWFC` | 솔버 클래스 |
| `TS` | 타일셋 테이블 (아래 참조) |
| `nearDensity` / `farDensity` | 페이싱 곡선. `y → 배율` |
| `mulberry32(seed)` | 결정론적 PRNG 팩토리 |
| `hash2(a, b)` | 2D 해시. 뷰에서 지터·색 흔들기에 씀 |
| `popcount(mask)` | 비트 수 = 엔트로피 |

### `new InfiniteWFC(width, seed, opts)`

```js
const wfc = new InfiniteWFC(20, 12345, { density: nearDensity });
```

| opts | 기본값 | 의미 |
|---|---|---|
| `bandH` | 18 | 한 번에 **푸는** 높이 (lookahead 포함) |
| `commitH` | 9 | 실제로 **확정하는** 높이 |
| `density` | `() => 1` | `y → 배율`. 구조 타일 가중치에 곱해짐 |

`bandH > commitH` 여야 합니다. 차이(9행)가 lookahead 이고, 이게 모순 방지의
전부입니다. 같게 만들면 막다른 길에 스스로 걸어 들어갑니다.

### 메서드

| 시그니처 | 동작 |
|---|---|
| `row(y) → Int8Array` | y행 반환. 없으면 **거기까지 생성**한다 |
| `tileAt(x, y) → int` | 타일 id. `x` 가 범위 밖이면 `0`(=`V`) |
| `prune(minY)` | `minY` 미만 행을 Map 에서 해제 |
| `captureNextBand(cb)` | 다음 밴드 1개의 연산을 기록해 `cb(trace)` 로 넘김 (1회성) |

> ⚠️ `row(y)` 는 **동기 생성 트리거**입니다. `row(100000)` 을 호출하면
> 그 자리에서 10만 행을 다 만듭니다. 카메라보다 얼마나 앞서 부르는지
> 항상 의식하세요.

### 필드

| 필드 | 의미 |
|---|---|
| `W` | 가로 폭 (고정) |
| `top` | 확정된 최상단 y. `prune` 해도 **줄어들지 않는다** |
| `rows` | `Map<y, Int8Array>`. 보유 행 수는 `prune` 으로 상수 유지 |
| `stats` | `{ bands, retries, seams, lastMs, avgMs }` |

**`stats.retries` / `stats.seams` 가 타일셋 건강 지표입니다.** 규칙을 바꾼 뒤
이 값이 0에서 올라가면 타일셋이 모순을 만들고 있다는 뜻입니다.
`seams` 는 12번 재시도가 다 실패해서 그 밴드를 전부 `V` 로 밀어버린 횟수 —
화면에 평평하게 잘린 흔적이 남습니다.

### `TS` (타일셋 테이블)

빌드 타임에 한 번 조립되는 상수입니다.

| 키 | 타입 | 내용 |
|---|---|---|
| `N` | int | 타일 수 (현재 **18**) |
| `names` | string[] | `V RUL RUM RUR RML RMM RMR RDL RDM RDR SUL SUM SUR SML SMR SDL SDM SDR` |
| `id` | `{name: idx}` | 이름 → 인덱스 |
| `RIGHT` `DOWN` | Int32Array | **손으로 선언한** 방향 |
| `LEFT` `UP` | Int32Array | **자동 유도된** 방향 — 손대지 말 것 |
| `W` | Float32Array | 가중치 |
| `isSpawn` | Uint8Array | 밀도 곡선을 곱할 대상 (`V` 만 0) |
| `meta` | `{kind, pos}[]` | 렌더링용. `kind` = `void`/`rock`/`station` |
| `FULL` | int | 전체 도메인 마스크 (`262143`) |
| `VMASK` | int | `1` — 맵 밖 경계 조건 |

---

## 3. 코드 지도

`wfc.js` 는 네 구역입니다. (줄 번호는 어긋날 수 있으니 함수명으로 찾으세요)

| 구역 | 함수 | 하는 일 |
|---|---|---|
| 1. 난수 | `mulberry32` `hash2` | 시드 → 같은 맵 |
| 2. 타일셋 | `buildTileset` (IIFE) | `decl` 표 → 비트마스크 4방향 + 가중치 |
| 3. 솔버 | `InfiniteWFC` | 아래 표 |
| 4. 페이싱 | `nearDensity` `farDensity` | 스크롤 거리 → 밀도 배율 |

`InfiniteWFC` 내부:

| 메서드 | 하는 일 |
|---|---|
| `_grow()` | 밴드 1개 생성. 최대 **12회 재시도** → 실패 시 `V` 폴백. trace 게이트가 여기 |
| `_solve(anchor, rnd)` | 밴드 1개 풀이. 성공 시 `Int8Array[]` (**index 0 = 앵커**), 실패 시 `null` |
| `_pick(mask, worldY, rnd)` | 가중 랜덤. `isSpawn` 타일에만 `density(worldY)` 를 곱함 |
| `_propagate(dom, stack, H)` | 스택 기반 제약 전파. 모순이면 `false` |
| `_pushNeighbors(stack, i, H)` | 4방향 이웃을 스택에 push (**자기 자신은 넣지 않음**) |

`_grow` 는 `sol[1..commitH]` 만 커밋합니다. `sol[0]` 은 입력이었던 앵커입니다.

---

## 4. 깨면 안 되는 불변조건

여기가 이 문서의 핵심입니다. 아래 항목은 각각 **조용히** 깨집니다 —
에러가 안 나고 결과만 서서히 이상해집니다.

### (1) 앵커 행 동결은 세 곳이 한 세트

```
_solve       dom[x] = 1 << anchor[x]     앵커를 확정 도메인으로 못박음
_propagate   if (r === 0) continue        앵커를 절대 좁히지 않음
_pushNeighbors  if (r > 1) push(i - W)    r=1 의 아래(=앵커)로는 전파 안 감
```

셋 중 하나만 고치면 **전파가 이미 확정된 과거를 덮어씁니다.** 그러면
커밋된 행과 새 밴드가 어긋나 이음매에 규칙 위반이 생기는데, 솔버는
성공했다고 보고합니다.

### (2) 붕괴 후에는 **이웃**을 스택에 넣는다

```js
dom[i] = 1 << chosen;
const st = [];
this._pushNeighbors(st, i, H);   // ← 자기 자신(i)이 아니라 이웃
```

자기 자신을 넣으면 `_propagate` 가 `d !== dom[i]` 비교에서 변화를 감지하지
못합니다(이미 확정된 도메인이라 그대로임). **전파가 조용히 죽고** 인접 규칙을
무시한 격자가 나옵니다.

### (3) `LEFT` / `UP` 은 손으로 채우지 않는다

```js
for (let s = 0; s < N; s++)
  for (let t = 0; t < N; t++) {
    if (RIGHT[s] & (1 << t)) LEFT[t] |= 1 << s;
    if (DOWN[s]  & (1 << t)) UP[t]   |= 1 << s;
  }
```

이 유도가 상호성(reciprocity)을 **구조적으로** 보장합니다. `decl` 표에
`RIGHT`/`DOWN` 만 적는 이유가 이것입니다. 역방향을 직접 편집하는 순간
"A의 오른쪽에 B는 되는데 B의 왼쪽에 A는 안 됨" 같은 비대칭 버그가
가능해집니다.

### (4) 타일 수 ≤ 31

도메인이 `int32` 비트마스크 하나입니다. 32번째 타일은 부호 비트(bit 31)를
쓰게 되어 마스크가 음수가 됩니다 — `FULL` 이 `N === 32` 를 특수 처리하고
`lowestIdx` 도 우연히 버티지만, 그 경계에 기대지 마세요. 코드 주석 기준
상한은 **31** 입니다. 현재 18개라 여유는 13개입니다.

### (5) 밀도는 `isSpawn` **전체**에 곱한다

`RDL` 에만 곱하면 제어가 샙니다 — `RDM` 이 선택되는 것만으로도 전파가
왼쪽에 `RDL` 을 채워 넣어 덩어리가 생깁니다. 구조 타일 전체에 같은 배율을
곱하면 서로의 비율(=모양)은 보존되고 `V` 대비 균형만 움직입니다.

### (6) 좌표계 — 월드 Y가 **위로** 증가

논문은 Y가 아래로 증가합니다. 여기서는 반대라서 솔버가 구조물을 아래에서
위로 쌓습니다.

- 빈 공간 위에 **처음 놓이는 것은 `D*`** (타일아트 기준 아랫줄) → 생성 트리거는 `RDL`
- **`U*` 는 덮개** → 높이를 결정 (`RML` vs `RUL` 가중치가 세로 길이 손잡이)

가중치를 만질 때 이걸 뒤집어 생각하면 정반대 결과가 나옵니다.

---

## 5. 타일 추가·수정 절차

1. **`names` 에 추가** — 31개 상한 확인
2. **`decl` 에 `[right[], down[]]` 선언** — `RIGHT`/`DOWN` 만. 역방향은 자동
3. **`V` 의 `decl` 도 손봐야 하는지 확인** — 새 구조물의 "시작 가장자리"가
   `V` 오른쪽/아래에 올 수 있어야 그 구조물이 생성됩니다. 빠뜨리면
   타일을 추가했는데 **한 번도 안 나오는** 현상이 생깁니다
4. **가중치 부여** — 생성 트리거 타일에만. 나머지는 전파로 강제되므로 무의미
5. **`meta` 확인** — `n[0] === 'R' ? 'rock' : 'station'` 규칙에 맞는 접두사인지.
   새 종류면 `meta` 매핑과 뷰의 렌더 분기를 같이 고쳐야 함
6. **재측정** — 아래 §7 검증 스크립트로 `retries`/`seams`/규칙위반이 0인지 확인

> 모순 0은 **이 타일셋에 대한 실측이지 증명이 아닙니다.** 규칙을 바꾸면
> 반드시 다시 재보세요.

---

## 6. trace / 시각화 계약

`captureNextBand(cb)` 로 밴드 1개의 연산을 기록합니다.
**`this.trace` 가 `null` 이면 비용은 이벤트당 분기 하나**라서 평상시 경로에
영향이 없습니다 (3000행 생성 594ms / 603ms — 측정 노이즈 수준).

이벤트 형태:

| `k` | 필드 | 의미 |
|---|---|---|
| `init` | `W, H, top, dom` | 밴드 시작. `dom` 은 초기 도메인 **복사본** |
| `observe` | `i, mask, chosen, ties, entropy` | 최소 엔트로피 칸을 하나로 확정 |
| `prop` | `i, from, to` | 전파가 이웃 도메인을 좁힘 |
| `fail` | `i` | 모순 — 이 시도는 폐기되고 재시도됨 |
| `done` | — | 전부 확정, 성공 |

`i` 는 `r * W + x` 이고 **`r = 0` 이 앵커(맨 아래)** 입니다. 화면에 그릴 때는
`H - 1 - r` 로 뒤집어야 월드와 방향이 맞습니다.

재시도가 일어나면 `init` 이 여러 번 나옵니다 — 재생기는 `init` 을
"상태 리셋" 으로 처리해야 합니다.

밴드당 이벤트는 대략 **2,455개 (관측 160 / 전파 2,293)** — 관측 1회에
전파가 평균 **14.3회** 입니다. 이 비율이 WFC 가 "제약 전파" 인 이유입니다.
재생 도중 화면에 뜨는 비율은 이보다 높게 보일 수 있는데, 밴드 초반에
전파가 몰리기 때문입니다(초기 전파가 전체 격자를 한 번 훑음).

3D 뷰의 패널 구현은 `index.html` 의 `viz` 객체와 `vizStep` / `vizDraw` 를
보세요. 솔버가 밴드를 1ms 안에 풀어버려서 실시간 관찰이 불가능하므로,
**기록해두고 느리게 재생**하는 구조입니다.

---

## 7. 검증 레시피

### 빌드 없이 Node 에서 바로 돌린다

`wfc.js` 는 순수 ESM 이고 브라우저 API 를 쓰지 않습니다(`performance.now()` 는
Node 16+ 전역). 그냥 import 하면 됩니다.

### 규칙 재검증 — 솔버를 신뢰하지 않는 검사

솔버가 "성공" 이라고 말해도 믿지 말고, 생성된 격자를 인접 규칙과 **독립적으로**
다시 검사합니다. §4의 불변조건이 깨지면 여기서 잡힙니다.

```js
import { InfiniteWFC, TS, nearDensity } from './wfc.js';

function validate(wfc, rows) {
  let bad = 0;
  for (let y = 1; y < rows; y++) {
    const cur = wfc.row(y), below = wfc.row(y - 1);
    for (let x = 0; x < wfc.W; x++) {
      const t = cur[x];
      if (!(TS.UP[below[x]] & (1 << t))) bad++;            // 세로
      const right = x + 1 < wfc.W ? cur[x + 1] : 0;        // 맵 밖 = V
      if (!(TS.RIGHT[t] & (1 << right))) bad++;            // 가로
    }
  }
  return bad;
}

let bad = 0, s = { bands: 0, retries: 0, seams: 0 };
for (let seed = 0; seed < 20; seed++) {
  const w = new InfiniteWFC(20, seed, { density: nearDensity });
  bad += validate(w, 5000);
  s.bands += w.stats.bands; s.retries += w.stats.retries; s.seams += w.stats.seams;
}
console.log(`밴드 ${s.bands} / 재시도 ${s.retries} / 이음매 ${s.seams} / 규칙위반 ${bad}`);
```

**기대값** (현재 타일셋, 시드 20 × 5,000행):

```
밴드 11120 / 재시도 0 / 이음매 0 / 규칙위반 0
```

### 브라우저 쪽 — `window.__wfc` 훅

`index.html` 이 헤드리스 검사용 훅을 노출합니다.

```js
window.__wfc = { wfc, TS, InfiniteWFC, nearDensity, viz, counts, actions }
```

- `counts` → `{ rock, stn }` 인스턴스 수. **스크롤해도 늘지 않아야** 정상
- `viz` → 시각화 패널 상태 (`open` `trace` `idx` `obs` `prop`)
- `actions` → `cam` `viz` `pause` `seed` `slow` `fast` 를 코드로 호출

`2d.html` 에는 이 훅이 없습니다.

---

## 8. 반복성 — 형상 vs 리듬

"같은 패턴이 반복되나?" 를 검증한 결과입니다. **두 답이 다릅니다.**

**형상은 사실상 반복되지 않습니다.** 6,000행에서 연속 블록 고유율:

| 창 크기 | 고유 비율 |
|---|---|
| 1행 | 36% |
| 2행 | 53% |
| 3행 | 66% |
| **5행** | **82%** |

1행만 보면 중복이 많지만 폭이 20칸뿐이라 당연합니다. 눈이 "덩어리" 로
인식하는 3~5행 창에서는 급격히 고유해집니다. 밴드마다
`hash2(seed, top * 131 + a)` 로 RNG 스트림이 갈리므로 **주기가 생길 수
없는 구조**입니다.

**리듬은 반복됩니다.** 밀도 시계열 자기상관이 **lag 299행에서 peak**:

```
nearDensity 주항 = sin(y * 0.021)  →  주기 2π/0.021 = 299.2행
```

기본 speed 6 기준 **약 50초마다** 한산↔빽빽 사이클이 한 바퀴 돕니다.
부항 `sin(y * 0.0053)` 은 1,186행 ≈ 3분 20초 주기의 더 긴 파도입니다.

→ 장시간 플레이에서 단조로움이 온다면 **형상이 아니라 여기서** 옵니다.
없애려면 `nearDensity` 를 시드 의존으로 만들거나 주파수 비를 무리수로
바꿔 주기를 깨면 됩니다.

---

## 9. 자주 밟는 지뢰

| 증상 | 원인 |
|---|---|
| 새 타일이 한 번도 안 나옴 | `V` 의 `decl` 에 그 구조물의 시작 가장자리를 안 넣음 (§5-3) |
| 격자가 규칙을 어기는데 솔버는 성공 보고 | 앵커 동결 3종 세트 중 하나가 깨짐 (§4-1) 또는 붕괴 후 자기 자신을 스택에 넣음 (§4-2) |
| 밀도를 올려도 별로 안 빽빽해짐 | 53% 가 이 타일셋의 기하학적 상한 (덩어리 사이 `V` 한 칸 필수). README 참조 |
| 밀도 손잡이가 안 먹음 | `isSpawn` 전체가 아니라 일부에만 곱함 (§4-5) |
| 가중치를 올렸는데 반대로 감 | 좌표계 뒤집힘 — `D*` 가 트리거, `U*` 가 덮개 (§4-6) |
| 메모리가 계속 늘어남 | `prune()` 을 안 부르거나, `row(y)` 를 카메라보다 너무 앞서 호출 |
| 프레임이 끊김 | 뷰에서 `row()` 를 큰 y로 호출해 대량 생성이 한 프레임에 몰림 |
| `seams` 가 0에서 올라감 | 타일셋이 모순을 만들고 있음. 규칙 변경 후 재측정 필요 |

---

## 참고

- 설계 근거·측정·한계·확장 방향 → [README.md](./README.md)
- 원 논문 — Soni Seli, *"Procedural Generation using Wave Function Collapse
  Algorithm"*, POLIS University, 2025 (Tiled Model)
