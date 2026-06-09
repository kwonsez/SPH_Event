// =============================================================
// Google Apps Script (GAS) - 돌림판 이벤트 백엔드 (v4, 2026-05-28 수정)
// =============================================================
// 📌 주요 변경점 (v2):
//   - 날짜 계산: KST 안전 (Utilities.formatDate + Date.UTC)
//   - 행사 시작 전/종료 후 스핀 거부 (rawDay 체크)
//   - ?action=debug 엔드포인트 추가 (서버 상태 검증용)
//   - rebaseForEvent(): Log 보존하며 안전 리셋
//   - 재고/할당 0 시 Fallback 다중화 (허위 차감 방지)
// =============================================================

const SPREADSHEET_ID = '1K678YnJ89e_kM2mfyWy1HYZc5mfwCNG8ASkrkAXM0I0';

// =============================================================
// 행사 설정
// =============================================================
// 2026-06-10(수) ~ 2026-06-12(금) 3일간
// Day1(수): 35%, Day2(목): 35%, Day3(금): 30%
const EVENT_CONFIG = {
  totalDays: 3,
  startDate: '2026-06-10',
  dailyWeights: [0.35, 0.35, 0.30],
};

// =============================================================
// 상품 설정
// =============================================================
// 총 재고 1,550개 — 행사 중 모두 소진되어도 OK (여분 재고 없음).
//
// 실제 당첨 확률 (서버 전용, 클라이언트는 모름):
//   보조배터리:    6.45%   (시각적으로는 12.5% 칸)
//   여행용 네임택: 3.23%   (시각적으로는 12.5% 칸)
//   치약칫솔세트: 12.90%   (시각적으로는 12.5% 칸)
//   하리보:       25.81%   (시각적으로는 25% = 2칸)
//   비타500스틱:  51.61%   (시각적으로는 37.5% = 3칸, ABSORBER)
//
// 확률 = 재고/총재고. 모든 상품이 비슷한 속도로 소진되어
// 행사 종료 시점에 같이 끝나도록 재고-비례로 설정.
// ABSORBER(vita500)는 baseProbability 무시하고 나머지 확률 흡수.
// =============================================================
const PRIZES = {
  battery:  { name: '보조배터리',     totalStock: 100, baseProbability: 0.0645 },
  nametag:  { name: '여행용 네임택',  totalStock: 50,  baseProbability: 0.0323 },
  toothset: { name: '치약칫솔세트',   totalStock: 200, baseProbability: 0.1290 },
  haribo:   { name: '하리보',         totalStock: 400, baseProbability: 0.2581 },
  vita500:  { name: '비타500스틱',    totalStock: 800, baseProbability: 0.5161 },
};

const PRIZE_ORDER = ['battery', 'nametag', 'toothset', 'haribo', 'vita500'];

// 나머지 확률을 흡수하는 상품 (baseProbability 무시, 1 - 나머지합 으로 계산)
const ABSORBER = 'vita500';

// =============================================================
// 웹 앱 엔드포인트
// =============================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  let result;
  try {
    if (action === 'spin') {
      result = handleSpin();
    } else if (action === 'stock') {
      result = handleStock();
    } else if (action === 'debug') {
      result = handleDebug();
    } else if (action === 'init') {
      result = handleInit();
    } else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: 'Server error: ' + (err && err.message ? err.message : String(err)) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================================================
// Day 계산 (KST 안전, EVENT_CONFIG 상수 기반)
// =============================================================
// 반환:
//   rawDay: 실제 계산된 일차 (0 이하 = 시작 전, totalDays 초과 = 종료 후)
//   effectiveDay: [1, totalDays] 범위로 clamp된 값
function getEffectiveDay_() {
  const tz = 'Asia/Seoul';
  const startStr = EVENT_CONFIG.startDate;
  const totalDays = EVENT_CONFIG.totalDays;

  // KST 기준 "오늘" 날짜 문자열 (서버 TZ 무관)
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // 순수 날짜 비교 (시각/시간대 오차 제거)
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const startMs = Date.UTC(sy, sm - 1, sd);

  const rawDay = Math.floor((todayMs - startMs) / 86400000) + 1;
  const effectiveDay = Math.max(1, Math.min(rawDay, totalDays));

  return {
    rawDay: rawDay,
    effectiveDay: effectiveDay,
    totalDays: totalDays,
    startDate: startStr,
    todayKst: todayStr,
  };
}

// =============================================================
// Rollover: 이전 날 미사용 할당량 합산 (handleSpin/handleDebug 공용)
// =============================================================
// allocRow: DailyAllocation 한 행의 값 배열 [prize_id, day1_alloc, day1_used, ...]
// effectiveDay가 1이면 루프가 돌지 않아 0 반환.
function sumRolledOver_(allocRow, effectiveDay) {
  let rolledOver = 0;
  for (let d = 1; d < effectiveDay; d++) {
    const dCol = 1 + (d - 1) * 2;
    const prevAlloc = Number(allocRow[dCol]) || 0;
    const prevUsed = Number(allocRow[dCol + 1]) || 0;
    rolledOver += Math.max(0, prevAlloc - prevUsed);
  }
  return rolledOver;
}

// =============================================================
// 디버그: 서버가 오늘을 어떻게 보는지 + 현재 시점 스핀 시뮬레이션
// =============================================================
// 사용: GAS_URL?action=debug
function handleDebug() {
  const info = getEffectiveDay_();

  // 현재 시점 effectiveRemaining/probabilities 시뮬레이션
  let snapshot = null;
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const stockSheet = ss.getSheetByName('Stock');
    const allocSheet = ss.getSheetByName('DailyAllocation');
    if (stockSheet && allocSheet) {
      const stockData = stockSheet.getDataRange().getValues();
      const allocData = allocSheet.getDataRange().getValues();
      const eff = info.effectiveDay;
      const dayCol = 1 + (eff - 1) * 2;

      const stockMap = {};
      for (let i = 1; i < stockData.length; i++) {
        const id = stockData[i][0];
        if (!id) continue;
        stockMap[id] = {
          remaining: Number(stockData[i][2]) || 0,
          baseProbability: Number(stockData[i][3]) || 0,
        };
      }

      const allocMap = {};
      for (let i = 1; i < allocData.length; i++) {
        const id = allocData[i][0];
        if (!id) continue;
        allocMap[id] = {
          rowIdx: i,
          dayAlloc: Number(allocData[i][dayCol]) || 0,
          dayUsed: Number(allocData[i][dayCol + 1]) || 0,
        };
      }

      const detail = {};
      let usedP = 0;
      for (const key of PRIZE_ORDER) {
        if (key === ABSORBER) continue;
        const rolledOver = sumRolledOver_(allocData[allocMap[key].rowIdx], eff);
        const todayBudgetLeft = (allocMap[key].dayAlloc + rolledOver) - allocMap[key].dayUsed;
        const effRem = Math.max(0, Math.min(todayBudgetLeft, stockMap[key].remaining));
        const canDraw = stockMap[key].remaining > 0 && effRem > 0;
        const prob = canDraw ? stockMap[key].baseProbability : 0;
        usedP += prob;
        detail[key] = {
          remaining: stockMap[key].remaining,
          dayAlloc: allocMap[key].dayAlloc,
          dayUsed: allocMap[key].dayUsed,
          usedFromToday: Math.min(allocMap[key].dayUsed, allocMap[key].dayAlloc),
          usedFromRollover: Math.max(0, allocMap[key].dayUsed - allocMap[key].dayAlloc),
          rolledOver: rolledOver,
          todayBudgetLeft: todayBudgetLeft,
          effectiveRemaining: effRem,
          canDraw: canDraw,
          probability: prob,
        };
      }
      const vRolled = sumRolledOver_(allocData[allocMap[ABSORBER].rowIdx], eff);
      const vBudget = (allocMap[ABSORBER].dayAlloc + vRolled) - allocMap[ABSORBER].dayUsed;
      const vEff = Math.max(0, Math.min(vBudget, stockMap[ABSORBER].remaining));
      const vCan = stockMap[ABSORBER].remaining > 0 && vEff > 0;
      const vProb = vCan ? Math.max(0, 1 - usedP) : 0;
      detail[ABSORBER] = {
        remaining: stockMap[ABSORBER].remaining,
        dayAlloc: allocMap[ABSORBER].dayAlloc,
        dayUsed: allocMap[ABSORBER].dayUsed,
        usedFromToday: Math.min(allocMap[ABSORBER].dayUsed, allocMap[ABSORBER].dayAlloc),
        usedFromRollover: Math.max(0, allocMap[ABSORBER].dayUsed - allocMap[ABSORBER].dayAlloc),
        rolledOver: vRolled,
        todayBudgetLeft: vBudget,
        effectiveRemaining: vEff,
        canDraw: vCan,
        probability: vProb,
      };
      snapshot = detail;
    }
  } catch (e) {
    snapshot = { error: String(e) };
  }

  return {
    today_kst: info.todayKst,
    startDate: info.startDate,
    totalDays: info.totalDays,
    rawDay: info.rawDay,
    effectiveDay: info.effectiveDay,
    isBeforeEvent: info.rawDay < 1,
    isAfterEvent: info.rawDay > info.totalDays,
    willAcceptSpin: info.rawDay >= 1 && info.rawDay <= info.totalDays,
    serverTime_iso: new Date().toISOString(),
    eventConfig: EVENT_CONFIG,
    snapshot: snapshot,
    version: 'v5-2026-06-10-3days-no-reserve', // ← 이 값으로 재배포 여부 확인
  };
}

// =============================================================
// 재고 조회
// =============================================================
function handleStock() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const stockSheet = ss.getSheetByName('Stock');
  if (!stockSheet) {
    return { error: '시트가 초기화되지 않았습니다. 편집기에서 manualRebase 또는 manualInit 실행 필요.' };
  }

  const data = stockSheet.getDataRange().getValues();
  const stock = {};
  for (let i = 1; i < data.length; i++) {
    const id = data[i][0];
    if (id) stock[id] = Number(data[i][2]) || 0;
  }
  return { stock: stock };
}

// =============================================================
// ★ 핵심: 돌림판 스핀 처리 (Lock + 무결성 보장)
// =============================================================
function handleSpin() {
  // 1) Day 검증 (Lock 전 - 행사 전/후 빠른 거부)
  const dayInfo = getEffectiveDay_();
  if (dayInfo.rawDay < 1) {
    return {
      error: '행사가 시작되지 않았습니다. (오늘: ' + dayInfo.todayKst + ', 시작일: ' + dayInfo.startDate + ')'
    };
  }
  if (dayInfo.rawDay > dayInfo.totalDays) {
    return { error: '행사가 종료되었습니다.' };
  }

  // 2) Lock 획득
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { error: '서버가 바쁩니다. 잠시 후 다시 시도해주세요.' };
  }

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const stockSheet = ss.getSheetByName('Stock');
    const allocSheet = ss.getSheetByName('DailyAllocation');
    const logSheet = ss.getSheetByName('Log');

    if (!stockSheet || !allocSheet || !logSheet) {
      return { error: '시트가 초기화되지 않았습니다. 편집기에서 manualRebase 실행 필요.' };
    }

    const effectiveDay = dayInfo.effectiveDay;

    // 3) 재고 읽기
    const stockData = stockSheet.getDataRange().getValues();
    const stockMap = {};
    for (let i = 1; i < stockData.length; i++) {
      const id = stockData[i][0];
      if (!id) continue;
      stockMap[id] = {
        row: i + 1,
        totalStock: Number(stockData[i][1]) || 0,
        remaining: Number(stockData[i][2]) || 0,
        baseProbability: Number(stockData[i][3]) || 0,
      };
    }

    // 4) 할당량 읽기
    const allocData = allocSheet.getDataRange().getValues();
    const allocMap = {};
    for (let i = 1; i < allocData.length; i++) {
      const id = allocData[i][0];
      if (!id) continue;
      const dayCol = 1 + (effectiveDay - 1) * 2; // 0-indexed column for dayN_alloc
      allocMap[id] = {
        row: i + 1,
        rowIdx: i,
        dayAlloc: Number(allocData[i][dayCol]) || 0,
        dayUsed: Number(allocData[i][dayCol + 1]) || 0,
        usedCol1Based: dayCol + 2, // 1-indexed column for dayN_used (for setRange)
      };
    }

    // 5) Rolling Allocation: 이전 날 미사용 할당 이월
    //    effectiveRemaining = "오늘 더 줄 수 있는 개수"
    //    = min(오늘 남은 할당 budget, 전체 남은 재고)
    //    ⚠️ 과거 버그: min(alloc, stock) - used → stock<alloc일 때 used를 두 번 차감하여 음수
    for (const key of PRIZE_ORDER) {
      if (!stockMap[key] || !allocMap[key]) continue;
      const rolledOver = sumRolledOver_(allocData[allocMap[key].rowIdx], effectiveDay);
      const todayBudgetLeft = (allocMap[key].dayAlloc + rolledOver) - allocMap[key].dayUsed;
      allocMap[key].rolledOver = rolledOver;                                    // source 판정용
      allocMap[key].effectiveRemaining = Math.max(0, Math.min(todayBudgetLeft, stockMap[key].remaining));
      allocMap[key].effectiveAlloc = allocMap[key].dayAlloc + rolledOver;       // 참고용 (블로킹엔 사용 안 함)
    }

    // 6) 확률 계산: 재고 & 할당 남아있는 상품만 확률 부여
    //    ABSORBER(vita500)는 나머지 확률을 흡수하므로 항상 마지막에 따로 계산.
    const probabilities = {};
    let usedProbability = 0;

    for (const key of PRIZE_ORDER) {
      if (key === ABSORBER) continue;
      const canDraw = stockMap[key] && stockMap[key].remaining > 0 &&
                      allocMap[key] && allocMap[key].effectiveRemaining > 0;
      probabilities[key] = canDraw ? stockMap[key].baseProbability : 0;
      usedProbability += probabilities[key];
    }

    // 흡수 상품(비타500): 나머지 확률 흡수 (단, 재고/할당 있을 때만)
    const absorberCanDraw = stockMap[ABSORBER] && stockMap[ABSORBER].remaining > 0 &&
                            allocMap[ABSORBER] && allocMap[ABSORBER].effectiveRemaining > 0;
    probabilities[ABSORBER] = absorberCanDraw ? Math.max(0, 1 - usedProbability) : 0;

    // 7) 추첨: Math.random() * totalProb로 정규화 스텝 생략 (부동소수점 안전)
    const totalProb = Object.values(probabilities).reduce((a, b) => a + b, 0);
    let selectedPrize = null;

    if (totalProb > 0) {
      const rand = Math.random() * totalProb;
      let cumulative = 0;
      for (const key of PRIZE_ORDER) {
        cumulative += probabilities[key];
        if (rand <= cumulative) {
          selectedPrize = key;
          break;
        }
      }
    }

    // 8) Fallback: 정상 추첨이 부동소수 오차 등으로 실패한 경우의 안전망.
    //    🔒 strict 모드 — 오늘 budget(dayAlloc + rolledOver) 한도 내에서만 선택.
    //       가중치 = effectiveRemaining (= min(오늘 budget 잔여, 전체 재고))
    //       → 오늘 budget 초과해 다음 날 물량을 빌려오지 않음.
    //    ⚠️ 과거 버그: PRIZE_ORDER 순서대로 첫 번째 선택 → battery 편향 발생 (가중 랜덤으로 해결)
    if (!selectedPrize) {
      const pool = [];
      let totalWeight = 0;
      for (const key of PRIZE_ORDER) {
        const eff = allocMap[key] ? allocMap[key].effectiveRemaining : 0;
        if (stockMap[key] && stockMap[key].remaining > 0 && eff > 0) {
          pool.push({ key: key, weight: eff });
          totalWeight += eff;
        }
      }
      if (pool.length > 0 && totalWeight > 0) {
        let r = Math.random() * totalWeight;
        for (const item of pool) {
          r -= item.weight;
          if (r <= 0) {
            selectedPrize = item.key;
            break;
          }
        }
        if (!selectedPrize) selectedPrize = pool[pool.length - 1].key;
      }
    }

    // 9) 최종: 뽑을 수 있는 상품 없음
    //    - 오늘 budget 소진 (재고는 남음)  → 오늘 마감, 내일 재시도
    //    - 전체 재고 소진                  → 행사 분배 종료
    if (!selectedPrize) {
      const anyStockLeft = PRIZE_ORDER.some(function (k) {
        return stockMap[k] && stockMap[k].remaining > 0;
      });
      return {
        error: anyStockLeft
          ? '오늘 추첨 가능한 수량이 모두 소진되었습니다. 내일 다시 시도해주세요.'
          : '모든 상품 재고가 소진되었습니다.',
        stock: getCurrentStock_(stockMap),
      };
    }

    // 10) 추첨 출처 판정 (alloc 업데이트 전 dayUsed 기준)
    //     이번 뽑기가 (dayUsed+1)번째 사용:
    //       - dayAlloc 이내       → 'today'    (오늘 새 할당분에서)
    //       - dayAlloc+rolledOver → 'rollover' (전날 이월분에서)
    //       - 그 이상             → 'overflow' (Fallback이 미래 일자 budget 차용)
    let source = 'today';
    if (allocMap[selectedPrize]) {
      const _du = allocMap[selectedPrize].dayUsed;
      const _da = allocMap[selectedPrize].dayAlloc;
      const _ro = allocMap[selectedPrize].rolledOver || 0;
      if (_du < _da) source = 'today';
      else if (_du < _da + _ro) source = 'rollover';
      else source = 'overflow';
    }

    // 11) 업데이트: stock + alloc → flush → log
    //     stock/alloc 먼저 확정해야 재고 보호. flush로 부분 기록 위험 최소화.
    //     log 실패는 비치명적 (사용자 당첨은 살리고 Logger.log로 흔적 남김).
    const newRemaining = stockMap[selectedPrize].remaining - 1;
    stockSheet.getRange(stockMap[selectedPrize].row, 3).setValue(newRemaining);

    if (allocMap[selectedPrize]) {
      const newUsed = allocMap[selectedPrize].dayUsed + 1;
      allocSheet.getRange(allocMap[selectedPrize].row, allocMap[selectedPrize].usedCol1Based)
        .setValue(newUsed);
    }

    SpreadsheetApp.flush(); // 재고 차감을 시트에 확정 (다음 단계 실패해도 살아남도록)

    try {
      logSheet.appendRow([
        new Date(),
        effectiveDay,
        selectedPrize,
        PRIZES[selectedPrize].name,
        source,
      ]);
    } catch (logErr) {
      // 로그 실패는 사용자 당첨을 무효화하지 않음. 재시도 시 이중당첨 방지.
      Logger.log('⚠️ Log append 실패 (재고는 차감됨): prize=' + selectedPrize +
                 ', day=' + effectiveDay + ', err=' + (logErr && logErr.message ? logErr.message : logErr));
    }

    stockMap[selectedPrize].remaining = newRemaining;

    return {
      prize: selectedPrize,
      name: PRIZES[selectedPrize].name,
      source: source,
      stock: getCurrentStock_(stockMap),
    };

  } catch (e) {
    return { error: '서버 오류: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    lock.releaseLock();
  }
}

// 현재 재고 맵 반환
function getCurrentStock_(stockMap) {
  const out = {};
  for (const key of PRIZE_ORDER) {
    out[key] = stockMap[key] ? stockMap[key].remaining : 0;
  }
  return out;
}

// =============================================================
// 할당 row 생성: 합계가 total과 정확히 일치하도록 마지막 날은 remainder
// =============================================================
function buildAllocRow_(prizeId, total) {
  const row = [prizeId];
  let allocated = 0;
  for (let d = 0; d < EVENT_CONFIG.totalDays - 1; d++) {
    const a = Math.round(total * EVENT_CONFIG.dailyWeights[d]);
    allocated += a;
    row.push(a, 0);
  }
  row.push(total - allocated, 0); // 마지막 날 = 나머지
  return row;
}

// =============================================================
// 초기화: 시트 구조 전부 새로 생성 (⚠️ Log 시트 내용 삭제됨)
// =============================================================
// 실행 주의: 처음 설치 시에만 사용. 행사 중에는 rebaseForEvent 사용.
function handleInit() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // Config
  let cfgSheet = ss.getSheetByName('Config') || ss.insertSheet('Config');
  cfgSheet.clear();
  cfgSheet.getRange('A1:B1').setValues([['key', 'value']]);
  cfgSheet.getRange('A2:B2').setValues([['totalDays', EVENT_CONFIG.totalDays]]);
  cfgSheet.getRange('A3:B3').setValues([['startDate', EVENT_CONFIG.startDate]]);
  cfgSheet.getRange('A4:B4').setValues([['dailyWeights', EVENT_CONFIG.dailyWeights.join(',')]]);

  // Stock
  let stockSheet = ss.getSheetByName('Stock') || ss.insertSheet('Stock');
  stockSheet.clear();
  stockSheet.getRange('A1:D1').setValues([['prize_id', 'total_stock', 'remaining', 'base_probability']]);
  let row = 2;
  for (const key of PRIZE_ORDER) {
    const p = PRIZES[key];
    stockSheet.getRange(row, 1, 1, 4).setValues([[key, p.totalStock, p.totalStock, p.baseProbability]]);
    row++;
  }

  // DailyAllocation
  let allocSheet = ss.getSheetByName('DailyAllocation') || ss.insertSheet('DailyAllocation');
  allocSheet.clear();
  const headers = ['prize_id'];
  for (let d = 1; d <= EVENT_CONFIG.totalDays; d++) {
    headers.push('day' + d + '_alloc', 'day' + d + '_used');
  }
  allocSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  row = 2;
  for (const key of PRIZE_ORDER) {
    const p = PRIZES[key];
    const rowData = buildAllocRow_(key, p.totalStock);
    allocSheet.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    row++;
  }

  // Log (⚠️ 기존 내용 삭제)
  let logSheet = ss.getSheetByName('Log') || ss.insertSheet('Log');
  logSheet.clear();
  logSheet.getRange('A1:E1').setValues([['timestamp', 'day_number', 'prize_id', 'prize_name', 'source']]);

  return { success: true, message: '초기화 완료 (Log 포함 모든 데이터 리셋됨).' };
}

// =============================================================
// ★ Rebase: Log 보존하며 Config/Stock/DailyAllocation 재설정
// =============================================================
// 현재 Stock.remaining을 "새 시작 재고(totalStock)"로 삼아
// 남은 일수에 맞춰 재할당한다. Log는 건드리지 않는다.
//
// 행사 시작 전(6/10) 편집기에서 1회 실행.
function rebaseForEvent() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 1) 현재 remaining 읽기 (없으면 PRIZES.totalStock 사용)
  const currentRemaining = {};
  const stockSheet0 = ss.getSheetByName('Stock');
  if (stockSheet0) {
    const data = stockSheet0.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const id = data[i][0];
      if (id) currentRemaining[id] = Number(data[i][2]) || 0;
    }
  }
  for (const key of PRIZE_ORDER) {
    if (currentRemaining[key] === undefined) {
      currentRemaining[key] = PRIZES[key].totalStock;
    }
  }

  // 2) Config
  let cfgSheet = ss.getSheetByName('Config') || ss.insertSheet('Config');
  cfgSheet.clear();
  cfgSheet.getRange('A1:B1').setValues([['key', 'value']]);
  cfgSheet.getRange('A2:B2').setValues([['totalDays', EVENT_CONFIG.totalDays]]);
  cfgSheet.getRange('A3:B3').setValues([['startDate', EVENT_CONFIG.startDate]]);
  cfgSheet.getRange('A4:B4').setValues([['dailyWeights', EVENT_CONFIG.dailyWeights.join(',')]]);

  // 3) Stock (새 totalStock = 현재 remaining)
  let stockSheet = ss.getSheetByName('Stock') || ss.insertSheet('Stock');
  stockSheet.clear();
  stockSheet.getRange('A1:D1').setValues([['prize_id', 'total_stock', 'remaining', 'base_probability']]);
  let row = 2;
  for (const key of PRIZE_ORDER) {
    const p = PRIZES[key];
    const rem = currentRemaining[key];
    stockSheet.getRange(row, 1, 1, 4).setValues([[key, rem, rem, p.baseProbability]]);
    row++;
  }

  // 4) DailyAllocation (합계가 재고와 정확히 일치)
  let allocSheet = ss.getSheetByName('DailyAllocation') || ss.insertSheet('DailyAllocation');
  allocSheet.clear();
  const headers = ['prize_id'];
  for (let d = 1; d <= EVENT_CONFIG.totalDays; d++) {
    headers.push('day' + d + '_alloc', 'day' + d + '_used');
  }
  allocSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  row = 2;
  for (const key of PRIZE_ORDER) {
    const rowData = buildAllocRow_(key, currentRemaining[key]);
    allocSheet.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    row++;
  }

  // 5) Log (생성만, 기존 내용 보존)
  //    기존 시트의 'source' 컬럼이 없으면 헤더만 추가 (기존 로그는 source 비어있음).
  let logSheet = ss.getSheetByName('Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Log');
    logSheet.getRange('A1:E1').setValues([['timestamp', 'day_number', 'prize_id', 'prize_name', 'source']]);
  } else {
    const header = logSheet.getRange(1, 1, 1, 5).getValues()[0];
    if (header[4] !== 'source') {
      logSheet.getRange(1, 5).setValue('source');
    }
  }

  const summary = {
    success: true,
    message: 'Rebase 완료. Log 보존됨.',
    eventConfig: EVENT_CONFIG,
    newStockBaseline: currentRemaining,
  };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

// =============================================================
// 편집기 직접 실행용 유틸
// =============================================================
function manualInit() {
  Logger.log('⚠️ manualInit은 Log 시트를 삭제합니다. 계속하려면 확인.');
  Logger.log(JSON.stringify(handleInit(), null, 2));
}

function manualRebase() {
  Logger.log(JSON.stringify(rebaseForEvent(), null, 2));
}

function manualDebug() {
  Logger.log(JSON.stringify(handleDebug(), null, 2));
}
