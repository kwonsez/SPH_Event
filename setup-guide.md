# 🎰 돌림판 이벤트 - 세팅 가이드

## 전체 구조

```
[아이패드 브라우저] ←→ [Google Apps Script 웹앱] ←→ [Google 스프레드시트 DB]
   (HTML/JS)              (서버 로직)                 (재고/로그 저장)
```

---

## STEP 1: 구글 스프레드시트 생성

1. Google Drive에서 **새 Google 스프레드시트** 생성
2. 이름: `돌림판이벤트DB` (자유)
3. URL에서 **스프레드시트 ID** 복사  
   → `https://docs.google.com/spreadsheets/d/`**여기가_ID**`/edit`

---

## STEP 2: Google Apps Script 설정

1. 스프레드시트에서 **확장 프로그램 → Apps Script** 클릭
2. 기본 코드(`myFunction`) 전부 삭제
3. `gas-backend.gs` 파일의 코드를 전체 복사 → 붙여넣기
4. 코드 상단의 `SPREADSHEET_ID`에 Step 1에서 복사한 ID 입력:
   ```javascript
   const SPREADSHEET_ID = '1ABC...xyz';
   ```
5. 행사 시작일 수정:
   ```javascript
   startDate: '2025-07-16',  // 실제 행사 시작일(수요일)로 변경
   ```
6. **저장** (Ctrl+S)

---

## STEP 3: 초기화 실행

1. Apps Script 에디터에서 함수 선택 드롭다운 → `manualInit` 선택
2. **실행** 버튼 클릭
3. 권한 승인 팝업 → **허용**
4. 스프레드시트로 돌아가면 4개 시트가 생성됨:
   - **Config**: 행사 설정
   - **Stock**: 상품별 전체/잔여 재고
   - **DailyAllocation**: 일별 할당량 및 사용량
   - **Log**: 당첨 기록 (시간, 상품 등)

---

## STEP 4: 웹 앱 배포

1. Apps Script 에디터 → 우측 상단 **배포 → 새 배포**
2. 유형: **웹 앱**
3. 설명: `돌림판 v1`
4. 실행 사용자: **나**
5. 액세스 권한: **모든 사용자** (⚠️ 중요!)
6. **배포** 클릭
7. 생성된 **웹 앱 URL** 복사 (https://script.google.com/macros/s/...)

---

## STEP 5: 프론트엔드 연결

1. `roulette.html` 파일 열기
2. 코드 상단의 `GAS_URL` 수정:
   ```javascript
   const GAS_URL = 'https://script.google.com/macros/s/여기에_URL/exec';
   ```
3. 저장

---

## STEP 6: 아이패드에서 실행

### 방법 A: 파일 직접 열기 (간단)
1. `roulette.html`을 Google Drive에 업로드
2. 아이패드에서 파일 다운로드 → Safari로 열기

### 방법 B: GitHub Pages (추천 - 안정적)
1. GitHub 무료 계정 생성
2. 새 Repository 생성 (Public)
3. `roulette.html`을 `index.html`로 이름변경 후 업로드
4. Settings → Pages → Source: main → 저장
5. `https://username.github.io/repo-name/` 으로 접속

### 방법 C: GAS에서 직접 서빙
1. Apps Script에 아래 코드를 `doGet` 위에 추가:
```javascript
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  
  if (!action) {
    // HTML 서빙 (action 파라미터 없으면)
    return HtmlService.createHtmlOutputFromFile('index')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  
  // 기존 API 로직...
}
```
2. Apps Script에서 파일 추가 → HTML → 이름: `index`
3. HTML 코드 붙여넣기 (GAS_URL을 현재 웹앱 URL로 설정)

---

## 확률 조정 방법

`gas-backend.gs`에서 `PRIZES` 객체의 `baseProbability` 수정:

| 상품 | 현재 확률 | 시각적 칸 크기 | 설명 |
|------|----------|--------------|------|
| 보조배터리 | 0.5% | 12.5% (1칸) | 초초고가 - 극히 낮은 확률 |
| 우산 | 1.0% | 12.5% (1칸) | 초고가 |
| 치약칫솔세트 | 5.0% | 12.5% (1칸) | 중고가 |
| 하리보 | 28.5% | 25% (2칸) | 기본 |
| 비타500스틱 | 65.0% | 37.5% (3칸) | 최다 재고 |

> 합계가 100%가 되어야 합니다.

---

## 요일별 트래픽 가중치

현재 설정 (수:목:금 = 40%:35%:25%):
```javascript
dailyWeights: [0.40, 0.35, 0.25],
```

첫날과 둘째날에 더 많은 재고가 할당됩니다.
남은 재고는 자동으로 다음 날로 이월됩니다.

---

## 행사 중 모니터링

Google 스프레드시트를 실시간으로 열어두면:
- **Stock 시트**: 각 상품별 남은 재고 확인
- **DailyAllocation 시트**: 일별 할당 대비 사용량
- **Log 시트**: 모든 당첨 기록 (시간순)

---

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| CORS 오류 | GAS 배포 시 "모든 사용자" 접근 확인 |
| 서버 연결 실패 | Wi-Fi 확인, GAS URL 확인 |
| 재고 안 줄어듦 | GAS 코드 재배포 (새 버전) |
| 확률 변경 후 미반영 | GAS 코드 수정 후 반드시 **새 배포** |

---

## 핵심 보안 포인트

✅ 모든 당첨 로직은 서버(GAS)에서 실행  
✅ 클라이언트 소스를 봐도 확률 조작 불가  
✅ LockService로 동시 요청 시 재고 초과 방지  
✅ 시각적 칸 크기 ≠ 실제 확률 (완벽 분리)
