# EVE CCTV

EVE Online CCTV 스크린샷 폴더를 감시하고 오버뷰, 프로브 스캐너, 도킹 카운터를 분석해 이벤트 타임라인을 만드는 로컬 웹앱입니다.

## 주요 기능

- 감시 캐릭터별 이미지 폴더 자동 스캔
- 오버뷰 기반 워프인·워프아웃·점프·도킹·언독 판정
- 코버트 옵스 함선의 코옵인·코옵아웃 분류
- 프로브 시그니처 생성·소멸 추적
- 이벤트 타입, 감시 클라이언트, 캐릭터, 함선, 콥 티커 필터 및 검색
- 판정에 사용한 전후 프레임 비교
- Tesseract OCR과 선택적 Ollama 비전 모델 지원

모든 이미지와 설정은 로컬에서 처리됩니다. Ollama 사용 시에도 외부 API를 호출하지 않습니다.

설치부터 영역 지정, 판정 방식, 검색과 문제 해결까지는 [상세 사용 설명서](docs/USER_GUIDE.md)를 참고하세요.

이 프로젝트의 아이디어와 작동 방식은 **HaSeungJun (LanturnHouse)**이 설계했으며, 해당 설계를 바탕으로 AI 코딩 도구와 함께 바이브 코딩 방식으로 구현했습니다. 역할별 상세 내용은 [기획 및 구현 기여](CONTRIBUTIONS.md)를 참고하세요.

## 요구 사항

- Windows 10/11
- Node.js 22.13 이상
- npm
- 선택 사항: NVIDIA GPU와 [Ollama](https://ollama.com/) (`qwen2.5vl:7b`)

## 설치

```powershell
npm ci
```

비전 모델을 사용하려면 Ollama 설치 후 모델을 받습니다.

```powershell
ollama pull qwen2.5vl:7b
```

## 실행

Windows에서는 `eve-cctv-start.bat`을 더블클릭하거나 다음 명령을 실행합니다.

```powershell
npm run dev
```

- 웹 화면: `http://localhost:5173`
- 로컬 감시 서비스: `http://127.0.0.1:8765`

처음 실행하면 설정에서 CCTV 폴더를 선택하고 감시 캐릭터 및 인식 영역을 등록합니다. 설정과 분석 상태는 `.local-data/eve-cctv.sqlite`에 저장됩니다.

## 인식 방식

설정 화면에서 다음 중 하나를 선택할 수 있습니다.

- **Tesseract 우선**: 기본 OCR로 처리하고 실패한 영역만 Ollama로 재시도
- **항상 비전 모델 사용**: 모든 영역을 Ollama로 처리
- **비전 모델 사용 안 함**: Tesseract만 사용

환경 변수로 기본값을 바꿀 수도 있습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `EVE_CCTV_SERVICE_PORT` | `8765` | 로컬 서비스 포트 |
| `EVE_CCTV_VISION_HOST` | `http://127.0.0.1:11434` | Ollama 주소 |
| `EVE_CCTV_VISION_MODEL` | `qwen2.5vl:7b` | 사용할 비전 모델 |
| `EVE_CCTV_VISION_MODE` | `fallback` | `off`, `fallback`, `always` |

## 검증

```powershell
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run analysis:smoke
npm run build
```

특정 이미지의 OCR 결과를 확인하려면:

```powershell
npm run ocr:smoke -- "C:\path\to\screenshot.png"
```

## 데이터 및 개인정보

다음 항목은 `.gitignore`에 포함되어 GitHub에 업로드되지 않습니다.

- CCTV 원본과 OCR 크롭: `.local-data/`
- 로컬 데이터베이스와 설정
- 환경 변수 파일: `.env*`
- 빌드 결과와 개발 서버 상태
- Ollama 모델 파일

## 참고

- 동일한 캐릭터의 파일은 CCTV 파일명에서 감지됩니다.
- UI 배율이나 EVE 창 위치가 바뀌면 인식 영역을 다시 지정해야 합니다.
- 프로브 시그니처 ID는 OCR 안정성을 위해 앞 3글자를 기준으로 추적합니다.
