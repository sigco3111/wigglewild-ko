# Wigglewild — 비공식 한국어판

직접 만든 크리처가 되어 섬을 누비는 브라우저 게임입니다. 다섯 종족과 떠돌이 거인이 사는 살아있는 섬에서 노래·춤·매력·포즈로 친구를 사귀거나, 물기·돌진·치기·뱉기로 싸우세요. 붙이는 부위마다 능력이 생기고, 모든 크리처는 저마다의 절차적 다리로 걷습니다.

이 저장소는 Patch의 [blendi/wigglewild](https://patch.gg/games/blendi/wigglewild)의 **비공식 한국어 번역 포크**입니다. UI, 튜토리얼, 도감, 에디터, 연구소, 인사 교환, 능력·특징·유전자 표기 등 사용자에게 보이는 문구를 한국어로 옮겼습니다.

**플레이 (한국어판):** https://sigco3111.github.io/wigglewild-ko/

**원작 플레이:** https://patch.gg/games/blendi/wigglewild

## 모드

- **플레이**: 섬. 둥지에서 부화하고, 열매를 먹고, 종족을 만나세요.
- **에디터**: 크리처를 조립하고 그대로 플레이할 수 있습니다.
- **연구소**: 치수, 능력치, 능력, 유전자, 가계도.
- **도감**: 만난 크리처 모음.
- **초원**: 샌드박스. 부화, 돌연변이, 교배.

## 로컬에서 실행

Node 20 이상이 필요합니다.

```sh
npm ci
npm run dev        # http://localhost:5173
npm run build      # dist/ 생성 (GitHub Pages에 올라가는 정적 산출물)
npm run preview    # http://localhost:8080
```

## 기술 노트

- 원본 TypeScript/three.js 코드베이스를 포크해 사용자 표시 문자열을 번역하고 Vite로 빌드합니다.
- 배포는 GitHub Pages(정적 산출물)로만 이루어지며, 별도 서버가 없습니다.
- 검증: 타입 검사(`tsc --noEmit`)와 프로덕션 빌드 통과. 게임 내 표시는 배포 화면 확인으로 검증합니다.
- 크리처 이름은 게임이 음절을 조합해 무작위로 만들며, 공유 코드에는 라틴 문자만 담기는 원작 설계를 그대로 유지했습니다(공유 코드 호환).

## 원작 및 라이선스

- 원작: [blendi/wigglewild](https://patch.gg/games/blendi/wigglewild) (Patch에서 제작, 2026)
- 원작 코드: MIT (`LICENSE`), 아트: CC0 1.0 (`LICENSE-ART`). 크리처·섬·효과는 모두 코드로 생성되고, 사운드는 Freesound와 Kenney의 CC0 녹음입니다(목록: `CREDITS.md`).
- 번들 라이브러리는 각자의 라이선스를 따릅니다(`LICENSES/`).
- 이 번역은 원작자와 무관한 비공식 팬 번역입니다.
