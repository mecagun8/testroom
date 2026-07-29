# testroom — WFC 무한 스크롤 배경 생성기

## 먼저 읽을 것

- **[IMPLEMENTATION.md](./IMPLEMENTATION.md)** — 코드를 만지기 전에.
  API 표면, **깨면 안 되는 불변조건**, 타일 추가 절차, 검증 스크립트.
- [README.md](./README.md) — 설계 근거, 측정 결과, 알려진 한계.

측정값은 이미 두 문서에 있습니다. 다시 구하지 말고 인용하세요.

## 구조

```
wfc.js       솔버 (렌더러 비의존) ← index.html 과 2d.html 이 공유
index.html   3D Three.js 뷰 + 터치 조작 + WFC 연산 시각화 패널
2d.html      2D 캔버스 뷰
vendor/      three.js 0.185 (MIT)
```

**`wfc.js` 를 고치면 3D·2D 양쪽이 동시에 영향받습니다. 반드시 둘 다 확인하세요.**

## 실행

로컬은 정적 서버가 필요합니다 (ES 모듈 + three.js ESM 이라 `file://` 불가).
배포본은 HTTPS 라 그냥 열립니다.

```bash
python3 -m http.server 8899
# http://localhost:8899/         3D
# http://localhost:8899/2d.html  2D
```

## 작업 시 주의

- **좌표계가 논문과 반대입니다.** 월드 Y가 위로 증가 → 생성 트리거는 `RDL`(아랫줄),
  `RUL` 은 덮개. 가중치를 만질 때 뒤집어 생각하면 정반대 결과가 나옵니다.
- **`stats.retries` / `stats.seams` 가 타일셋 건강 지표입니다.** 0에서 올라가면
  규칙이 모순을 만들고 있다는 뜻. 타일셋을 바꿨으면 IMPLEMENTATION.md §7 의
  검증 스크립트로 재측정하세요 (기대값: 재시도 0 / 이음매 0 / 규칙위반 0).
- **`row(y)` 는 동기 생성 트리거입니다.** 큰 y를 넣으면 그 자리에서 다 만듭니다.
- 헤드리스 검증은 `index.html` 의 `window.__wfc` 훅으로. `2d.html` 에는 없습니다.

## 배포

GitHub Pages 가 이 저장소를 서빙합니다. **Pages 소스가 기본 브랜치가 아니라
작업 브랜치로 설정되어 있으니**(Settings → Pages 에서 확인), 브랜치를 지우거나
푸시할 때 라이브 사이트에 미치는 영향을 먼저 확인하세요.
