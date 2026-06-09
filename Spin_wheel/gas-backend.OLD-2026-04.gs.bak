// =============================================================
// Google Apps Script (GAS) - 돌림판 이벤트 백엔드
// =============================================================
// 📌 사용법:
// 1. Google Drive → 새 Google 스프레드시트 생성
// 2. 확장 프로그램 → Apps Script 클릭
// 3. 이 코드를 전체 붙여넣기
// 4. 아래 SPREADSHEET_ID에 스프레드시트 ID 입력
// 5. 배포 → 새 배포 → 웹 앱 → 액세스: 모든 사용자 → 배포
// 6. 받은 URL을 프론트엔드 HTML의 GAS_URL에 붙여넣기
// =============================================================

// ★ 여기에 본인의 스프레드시트 ID를 넣으세요
const SPREADSHEET_ID = '1K678YnJ89e_kM2mfyWy1HYZc5mfwCNG8ASkrkAXM0I0';

// =============================================================
// 행사 설정
// =============================================================
const EVENT_CONFIG = {
  totalDays: 3,           // 행사 총 일수 (수, 목, 금)
  startDate: '2026-04-22', // 행사 시작일 (수요일) - 본인 일정에 맞게 수정
  
  // 요일별 트래픽 가중치 (수:목:금 = 40%:35%:25%)
  // 첫날/둘째날이 가장 많을 것으로 예상
  dailyWeights: [0.40, 0.35, 0.25],
};

// =============================================================
// 상품 설정
// =============================================================
// ★ 핵심: 시각적 룰렛 칸 크기(1/8 = 12.5%)와 실제 당첨 확률은 완전 분리됨
// 
// 실제 당첨 확률 (서버에서만 사용, 클라이언트는 모름):
//   보조배터리:    0.5%   (시각적으로는 12.5% 칸)
//   우산:          1.0%   (시각적으로는 12.5% 칸)
//   치약칫솔세트:  5.0%   (시각적으로는 12.5% 칸)
//   하리보:       28.5%   (시각적으로는 25% = 2칸)
//   비타500스틱:  65.0%   (시각적으로는 37.5% = 3칸)
// =============================================================

const PRIZES = {
  battery:  { name: '보조배터리',   totalStock: 80,  baseProbability: 0.005 },
  umbrella: { name: '우산',         totalStock: 70,  baseProbability: 0.010 },
  toothset: { name: '치약칫솔세트', totalStock: 200, baseProbability: 0.050 },
  haribo:   { name: '하리보',       totalStock: 460, baseProbability: 0.285 },
  vita500:  { name: '비타500스틱',  totalStock: 650, baseProbability: 0.650 },
};

// 확률 순서 (고가 → 저가)
const PRIZE_ORDER = ['battery', 'umbrella', 'toothset', 'haribo', 'vita500'];

// =============================================================
// 웹 앱 엔드포인트
// =============================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  
  let result;
  
  if (action === 'spin') {
    result = handleSpin();
  } else if (action === 'stock') {
    result = handleStock();
  } else if (action === 'init') {
    result = handleInit();
  } else {
    result = { error: 'Unknown action' };
  }
  
  const output = ContentService.createTextOutput(JSON.stringify(result));
  output.setMimeType(ContentService.MimeType.JSON);
  
  // CORS 허용
  return output;
}

// =============================================================
// 초기화: 스프레드시트 시트 구조 생성
// =============================================================
function handleInit() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // --- Config 시트 ---
  let configSheet = ss.getSheetByName('Config');
  if (!configSheet) {
    configSheet = ss.insertSheet('Config');
  }
  configSheet.clear();
  configSheet.getRange('A1:B1').setValues([['key', 'value']]);
  configSheet.getRange('A2:B2').setValues([['totalDays', EVENT_CONFIG.totalDays]]);
  configSheet.getRange('A3:B3').setValues([['startDate', EVENT_CONFIG.startDate]]);
  configSheet.getRange('A4:B4').setValues([['dailyWeights', EVENT_CONFIG.dailyWeights.join(',')]]);
  
  // --- Stock 시트 ---
  let stockSheet = ss.getSheetByName('Stock');
  if (!stockSheet) {
    stockSheet = ss.insertSheet('Stock');
  }
  stockSheet.clear();
  stockSheet.getRange('A1:D1').setValues([['prize_id', 'total_stock', 'remaining', 'base_probability']]);
  
  let row = 2;
  for (const key of PRIZE_ORDER) {
    const p = PRIZES[key];
    stockSheet.getRange(row, 1, 1, 4).setValues([[key, p.totalStock, p.totalStock, p.baseProbability]]);
    row++;
  }
  
  // --- DailyAllocation 시트 ---
  let allocSheet = ss.getSheetByName('DailyAllocation');
  if (!allocSheet) {
    allocSheet = ss.insertSheet('DailyAllocation');
  }
  allocSheet.clear();
  
  // 헤더
  const headers = ['prize_id'];
  for (let d = 1; d <= EVENT_CONFIG.totalDays; d++) {
    headers.push('day' + d + '_alloc', 'day' + d + '_used');
  }
  allocSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // 가중치 기반 일일 할당량 계산
  row = 2;
  for (const key of PRIZE_ORDER) {
    const p = PRIZES[key];
    const rowData = [key];
    for (let d = 0; d < EVENT_CONFIG.totalDays; d++) {
      const alloc = Math.ceil(p.totalStock * EVENT_CONFIG.dailyWeights[d]);
      rowData.push(alloc, 0); // alloc, used=0
    }
    allocSheet.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    row++;
  }
  
  // --- Log 시트 ---
  let logSheet = ss.getSheetByName('Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Log');
  }
  logSheet.clear();
  logSheet.getRange('A1:D1').setValues([['timestamp', 'day_number', 'prize_id', 'prize_name']]);
  
  return { success: true, message: '초기화 완료! 스프레드시트를 확인하세요.' };
}

// =============================================================
// 재고 조회
// =============================================================
function handleStock() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const stockSheet = ss.getSheetByName('Stock');
  
  if (!stockSheet) {
    return { error: '시트가 초기화되지 않았습니다. ?action=init 을 먼저 호출하세요.' };
  }
  
  const data = stockSheet.getDataRange().getValues();
  const stock = {};
  
  for (let i = 1; i < data.length; i++) {
    stock[data[i][0]] = data[i][2]; // remaining
  }
  
  return { stock: stock };
}

// =============================================================
// ★ 핵심: 돌림판 스핀 처리 (확률 조작 + 재고 관리 + Lock)
// =============================================================
function handleSpin() {
  const lock = LockService.getScriptLock();
  
  try {
    // 최대 10초 대기 후 Lock 획득
    lock.waitLock(10000);
  } catch (e) {
    return { error: '서버가 바쁩니다. 잠시 후 다시 시도해주세요.' };
  }
  
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const stockSheet = ss.getSheetByName('Stock');
    const allocSheet = ss.getSheetByName('DailyAllocation');
    const logSheet = ss.getSheetByName('Log');
    
    if (!stockSheet || !allocSheet) {
      return { error: '시트가 초기화되지 않았습니다.' };
    }
    
    // --- 현재 날짜 기반 Day 번호 계산 ---
    const today = new Date();
    const startDate = new Date(EVENT_CONFIG.startDate + 'T00:00:00+09:00');
    const diffMs = today.getTime() - startDate.getTime();
    const dayNumber = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
    
    // 행사 기간 체크 (넉넉하게 전후 여유)
    const effectiveDay = Math.max(1, Math.min(dayNumber, EVENT_CONFIG.totalDays));
    
    // --- 재고 데이터 읽기 ---
    const stockData = stockSheet.getDataRange().getValues();
    const stockMap = {};
    for (let i = 1; i < stockData.length; i++) {
      stockMap[stockData[i][0]] = {
        row: i + 1,
        totalStock: stockData[i][1],
        remaining: stockData[i][2],
        baseProbability: stockData[i][3],
      };
    }
    
    // --- 일일 할당량 데이터 읽기 ---
    const allocData = allocSheet.getDataRange().getValues();
    const allocMap = {};
    for (let i = 1; i < allocData.length; i++) {
      const prizeId = allocData[i][0];
      const dayCol = 1 + (effectiveDay - 1) * 2; // alloc column for this day
      allocMap[prizeId] = {
        row: i + 1,
        dayAlloc: allocData[i][dayCol],
        dayUsed: allocData[i][dayCol + 1],
        allocCol: dayCol + 1, // 1-indexed
        usedCol: dayCol + 2,  // 1-indexed
      };
    }
    
    // --- Rolling Allocation: 이전 날 남은 재고 이월 ---
    // 오늘 가용량 = 오늘 기본 할당량 + 이전 날들의 미사용량
    // 단, 전체 remaining을 넘지 않음
    for (const key of PRIZE_ORDER) {
      let rolledOver = 0;
      if (effectiveDay > 1) {
        for (let d = 1; d < effectiveDay; d++) {
          const dayCol = 1 + (d - 1) * 2;
          const prevAlloc = allocData[PRIZE_ORDER.indexOf(key) + 1][dayCol];
          const prevUsed = allocData[PRIZE_ORDER.indexOf(key) + 1][dayCol + 1];
          rolledOver += Math.max(0, prevAlloc - prevUsed);
        }
      }
      allocMap[key].effectiveAlloc = Math.min(
        allocMap[key].dayAlloc + rolledOver,
        stockMap[key].remaining
      );
      allocMap[key].effectiveRemaining = allocMap[key].effectiveAlloc - allocMap[key].dayUsed;
    }
    
    // --- 확률 계산 ---
    // 1단계: 고가 상품부터 확률 계산
    //   - 재고 있고 + 일일 할당 남아있으면 → baseProbability 적용
    //   - 재고 없거나 할당 소진 → 확률 0
    // 2단계: 남은 확률은 저가 상품(비타500 > 하리보)이 흡수
    
    let probabilities = {};
    let usedProbability = 0;
    
    // 고가~중가 상품 (battery, umbrella, toothset)
    for (const key of ['battery', 'umbrella', 'toothset']) {
      const s = stockMap[key];
      const a = allocMap[key];
      
      if (s.remaining > 0 && a.effectiveRemaining > 0) {
        probabilities[key] = s.baseProbability;
      } else {
        probabilities[key] = 0;
      }
      usedProbability += probabilities[key];
    }
    
    // 하리보
    const hariboStock = stockMap['haribo'];
    const hariboAlloc = allocMap['haribo'];
    if (hariboStock.remaining > 0 && hariboAlloc.effectiveRemaining > 0) {
      probabilities['haribo'] = hariboStock.baseProbability;
    } else {
      probabilities['haribo'] = 0;
    }
    usedProbability += probabilities['haribo'];
    
    // 비타500: 나머지 확률 모두 가져감
    const vita500Stock = stockMap['vita500'];
    const vita500Alloc = allocMap['vita500'];
    if (vita500Stock.remaining > 0) {
      probabilities['vita500'] = Math.max(0, 1 - usedProbability);
    } else {
      probabilities['vita500'] = 0;
    }
    
    // --- 예외 처리: 모든 상품 소진 시 ---
    const totalProb = Object.values(probabilities).reduce((a, b) => a + b, 0);
    if (totalProb === 0) {
      // 최후의 안전장치: 비타500 강제 당첨 (재고 무시)
      return {
        prize: 'vita500',
        name: '비타500스틱',
        stock: getCurrentStock(stockMap),
        message: '모든 상품이 소진되었지만 비타500을 드립니다!'
      };
    }
    
    // --- 확률 정규화 ---
    const normalizedProb = {};
    for (const key of PRIZE_ORDER) {
      normalizedProb[key] = probabilities[key] / totalProb;
    }
    
    // --- 추첨 ---
    const rand = Math.random();
    let cumulative = 0;
    let selectedPrize = 'vita500'; // 기본 폴백
    
    for (const key of PRIZE_ORDER) {
      cumulative += normalizedProb[key];
      if (rand <= cumulative) {
        selectedPrize = key;
        break;
      }
    }
    
    // --- 당첨 결과 기록 ---
    // 재고 차감
    const selectedStock = stockMap[selectedPrize];
    stockSheet.getRange(selectedStock.row, 3).setValue(selectedStock.remaining - 1);
    
    // 일일 사용량 증가
    const selectedAlloc = allocMap[selectedPrize];
    allocSheet.getRange(selectedAlloc.row, selectedAlloc.usedCol).setValue(selectedAlloc.dayUsed + 1);
    
    // 로그 기록
    logSheet.appendRow([
      new Date(),
      effectiveDay,
      selectedPrize,
      PRIZES[selectedPrize].name,
    ]);
    
    // 업데이트된 재고 반환
    stockMap[selectedPrize].remaining -= 1;
    
    return {
      prize: selectedPrize,
      name: PRIZES[selectedPrize].name,
      stock: getCurrentStock(stockMap),
    };
    
  } catch (e) {
    return { error: '서버 오류: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// 현재 재고 맵 반환
function getCurrentStock(stockMap) {
  const result = {};
  for (const key of PRIZE_ORDER) {
    result[key] = stockMap[key].remaining;
  }
  return result;
}

// =============================================================
// 유틸: 수동 초기화 실행 (Apps Script 에디터에서 직접 실행)
// =============================================================
function manualInit() {
  const result = handleInit();
  Logger.log(result);
}
