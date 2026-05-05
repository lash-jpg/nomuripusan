/**
 * 무리없이 부산 — 코스 상세 + 지도 렌더링.
 */
(async function () {
  const urlId = new URLSearchParams(location.search).get('id');
  let course = AppState.selected_course;

  if (urlId && (!course || course.id !== urlId)) {
    course = (AppState.courses || []).find(c => c.id === urlId) || null;
  }
  if (!course && urlId) {
    course = await apiGet('/api/courses/' + encodeURIComponent(urlId));
  }
  if (course) {
    AppState.selected_course = course;
    document.title = `${course.name} — 무리없이 부산`;
  }

  if (!course) {
    const emptyHtml = `
      <div class="empty-state">
        <div class="icon" aria-hidden="true">📭</div>
        <h3>코스 정보가 없습니다</h3>
        <p>추천 결과에서 코스를 선택해주세요.</p>
        <button class="btn-outline" style="width:auto;padding:0 24px;margin-top:8px" onclick="navigateTo('/results.html')">결과 목록으로</button>
      </div>`;
    ['courseOverview','courseOverviewPc','timelineList','timelineListPc'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = emptyHtml;
    });
    return;
  }

  // ── 공유 모듈 키 보장 ─────────────────────────────
  let kakaoLoader = null;

  function waitForKakaoKey(timeoutMs = 1500) {
    if (Object.prototype.hasOwnProperty.call(window, 'KAKAO_MAP_KEY')) {
      return Promise.resolve(window.KAKAO_MAP_KEY || null);
    }
    return new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        if (Object.prototype.hasOwnProperty.call(window, 'KAKAO_MAP_KEY')) {
          resolve(window.KAKAO_MAP_KEY || null);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(poll, 30);
      };
      poll();
    });
  }

  // ── 1. Kakao SDK 로딩 (버그 수정: 이미 로드된 스크립트 처리) ──────
  function loadKakaoSdk() {
    if (window.kakao && window.kakao.maps) return Promise.resolve(window.kakao);
    if (kakaoLoader) return kakaoLoader;
    if (!window.KAKAO_MAP_KEY) return Promise.reject(new Error('KAKAO_MAP_KEY missing'));

    kakaoLoader = new Promise((resolve, reject) => {
      // B-001: 실패 시 kakaoLoader를 null로 리셋하여 재시도 가능하게
      const doReject = (err) => { kakaoLoader = null; reject(err); };
      const finish = () => {
        if (!window.kakao) return doReject(new Error('kakao 없음'));
        window.kakao.maps.load(() => resolve(window.kakao));
      };

      const existing = document.getElementById('kakao-map-sdk');
      if (existing) {
        // 스크립트 태그가 이미 있을 때: kakao 객체 존재 여부로 분기
        if (window.kakao) {
          finish();
        } else {
          existing.addEventListener('load', finish, { once: true });
          existing.addEventListener('error', doReject, { once: true });
          // 스크립트가 이미 로드 완료됐지만 이벤트를 놓쳤을 경우 대비
          setTimeout(() => { if (window.kakao) finish(); }, 200);
        }
        return;
      }

      const script = document.createElement('script');
      script.id = 'kakao-map-sdk';
      // services 라이브러리 포함 (Places 검색에 필요)
      script.src = `//dapi.kakao.com/v2/maps/sdk.js?appkey=${window.KAKAO_MAP_KEY}&autoload=false&libraries=services`;
      script.onload = finish;
      script.onerror = doReject;
      document.head.appendChild(script);
    });

    return kakaoLoader;
  }

  // ── 2. OSRM 실제 도로 경로 조회 ─────────────────────────────────
  async function fetchRoadPath(spotList) {
    if (spotList.length < 2) return null;
    try {
      // B-002: kakao 로드 보장 (race condition 방지)
      await loadKakaoSdk();
      const coords = spotList.map(s => `${s.lng},${s.lat}`).join(';');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.[0]) {
        // B-002: optional chaining으로 kakao.maps.LatLng 접근 안전화
        if (!kakao?.maps?.LatLng) return null;
        return data.routes[0].geometry.coordinates.map(
          ([lng, lat]) => new kakao.maps.LatLng(lat, lng)
        );
      }
    } catch (_) {}
    return null;
  }

  // ── 3. 카카오맵 렌더링 (실제 도로 경로 적용) ────────────────────
  let activeMap = null;   // 재사용할 map 인스턴스 ref

  async function renderKakaoMap(spotList, container) {
    const mapEl = document.createElement('div');
    mapEl.style.cssText = 'width:100%;height:100%;border-radius:12px;';
    container.innerHTML = '';
    container.appendChild(mapEl);

    const center = new kakao.maps.LatLng(spotList[0].lat, spotList[0].lng);
    const map = new kakao.maps.Map(mapEl, { center, level: 6 });
    activeMap = map;

    // 커스텀 번호 마커
    spotList.forEach((spot, i) => {
      const pos = new kakao.maps.LatLng(spot.lat, spot.lng);
      const content = `<div style="background:#003087;color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer">${i + 1}</div>`;
      const overlay = new kakao.maps.CustomOverlay({ position: pos, content, map, zIndex: 10 });

      const infoWindow = new kakao.maps.InfoWindow({
        content: `<div style="padding:8px 12px;font-size:13px;font-weight:600;white-space:nowrap;max-width:180px">${escapeHtml(spot.name)}</div>`,
      });
      // 오버레이 div 클릭 → 인포창
      overlay.getContent && setTimeout(() => {
        const el = overlay.getContent();
        if (el && el.addEventListener) {
          el.addEventListener('click', () => {
            infoWindow.open(map, new kakao.maps.Marker({ position: pos }));
          });
        }
      }, 0);
    });

    // 경로 그리기: OSRM 실도로 → 실패 시 직선
    if (spotList.length > 1) {
      const roadPath = await fetchRoadPath(spotList);
      const path = roadPath || spotList.map(s => new kakao.maps.LatLng(s.lat, s.lng));
      new kakao.maps.Polyline({
        path,
        strokeWeight: 5,
        strokeColor: '#003087',
        strokeOpacity: 0.85,
        strokeStyle: roadPath ? 'solid' : 'dashed',
        map,
      });
      if (!roadPath) {
        showToast('도로 경로를 불러오지 못해 직선 경로로 표시했어요.', 'info');
      }
    }

    // 모든 마커가 보이도록 bounds 조정
    const bounds = new kakao.maps.LatLngBounds();
    spotList.forEach(s => bounds.extend(new kakao.maps.LatLng(s.lat, s.lng)));
    map.setBounds(bounds, 60);

    return map;
  }

  // ── 4. 지도 없을 때 SVG 대체 ────────────────────────────────────
  function renderMockMap(spotList, container) {
    if (!spotList?.length) return;
    const W = 360, H = 280;
    const lats = spotList.map(s => s.lat), lngs = spotList.map(s => s.lng);
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
    const pad = 48;
    const toX = lng => maxLng === minLng ? W / 2 : pad + (lng - minLng) / (maxLng - minLng) * (W - pad * 2);
    const toY = lat => maxLat === minLat ? H / 2 : pad + (maxLat - lat) / (maxLat - minLat) * (H - pad * 2);
    const coords = spotList.map(s => ({ x: toX(s.lng), y: toY(s.lat) }));
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;border-radius:12px;">
      <rect width="${W}" height="${H}" fill="#e8f0fe" rx="12"/>
      ${[1,2,3,4].map(i => `<line x1="${i*W/5}" y1="0" x2="${i*W/5}" y2="${H}" stroke="#c5d5f5" stroke-width=".5" opacity=".6"/>
        <line x1="0" y1="${i*H/5}" x2="${W}" y2="${i*H/5}" stroke="#c5d5f5" stroke-width=".5" opacity=".6"/>`).join('')}
      ${coords.length > 1 ? coords.slice(1).map((c, i) =>
        `<line x1="${coords[i].x}" y1="${coords[i].y}" x2="${c.x}" y2="${c.y}" stroke="#003087" stroke-width="2.5" stroke-dasharray="6,3" opacity=".6"/>`).join('') : ''}
      ${coords.map((c, i) => `
        <circle cx="${c.x}" cy="${c.y}" r="18" fill="white" stroke="#003087" stroke-width="2.5"/>
        <circle cx="${c.x}" cy="${c.y}" r="14" fill="#003087"/>
        <text x="${c.x}" y="${c.y}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="white" font-family="sans-serif">${i+1}</text>`).join('')}
      ${coords.map((c, i) => {
        const name = spotList[i].name.length > 6 ? spotList[i].name.slice(0,6)+'…' : spotList[i].name;
        const labelY = c.y + (c.y > H/2 ? -28 : 28);
        return `<text x="${c.x}" y="${labelY}" text-anchor="middle" font-size="10" fill="#172B4D" font-weight="600" font-family="sans-serif">${name}</text>`;
      }).join('')}
    </svg>`;
  }

  // ── XSS 방지 헬퍼 ────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ── 5. 코스 렌더링 ───────────────────────────────────────────────
  let spots = [...(course.spots || [])];
  let legs  = [...(course.legs  || [])];

  const courseTitle = document.getElementById('courseTitle');
  if (courseTitle) courseTitle.textContent = course.name;

  function buildOverviewHTML() {
    const avgGrade = course.accessibility_avg || 3;
    const totalTime = spots.reduce((a, s) => a + s.visit_time_min, 0) + legs.reduce((a, l) => a + (l.recommended_time_min || 0), 0);
    const totalDist = legs.reduce((a, l) => a + (l.recommended_distance_m || 0), 0);
    return `
      <div class="course-overview-title">${escapeHtml(course.name)}</div>
      <div class="course-overview-meta">
        <div class="item"><span aria-hidden="true">⏱</span> 약 ${Math.round(totalTime)}분</div>
        <div class="item"><span aria-hidden="true">📏</span> ${(totalDist/1000).toFixed(1)}km</div>
        <div class="item"><span aria-hidden="true">📍</span> ${spots.length}개소</div>
        <div class="item"><span aria-hidden="true">🚻</span> 쉼터 ${spots.filter(s=>s.restroom_accessible).length}개</div>
      </div>
      <div class="access-grade-large">
        <div class="dots">${Array.from({length:5},(_,i)=>`<span class="dot-lg ${i<Math.round(avgGrade)?'filled':'empty'}"></span>`).join('')}</div>
        <p>접근성 ${gradeLabel(Math.round(avgGrade))} · 피로도 ${course.total_fatigue}</p>
      </div>
      ${course.ai_description ? `
      <div class="course-ai-block" style="margin:12px 0 0">
        <span class="course-ai-label">✦ 추천 이유</span>
        <p class="course-ai-desc">${escapeHtml(course.ai_description)}</p>
        ${course.ai_highlights?.length ? `<div class="course-ai-chips">${course.ai_highlights.map(h=>`<span class="ai-chip">${escapeHtml(h)}</span>`).join('')}</div>` : ''}
        ${course.ai_tip ? `<div class="course-ai-tip">💡 ${escapeHtml(course.ai_tip)}</div>` : ''}
      </div>` : ''}`;
  }

  function renderOverview() {
    ['courseOverview','courseOverviewPc'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = buildOverviewHTML();
    });
  }

  function buildTimelineItem(spot, idx) {
    const chips = [
      spot.wheelchair_accessible === true ? {label:'♿ 휠체어 OK',ok:true,cls:'ok'}
        : spot.wheelchair_accessible === false ? {label:'♿ 휠체어 제한',ok:false,cls:'warn'}
        : {label:'♿ 휠체어 미확인',ok:false,cls:'unknown'},
      spot.stroller_accessible === true ? {label:'🍼 유아차 OK',ok:true,cls:'ok'}
        : spot.stroller_accessible === false ? {label:'🍼 유아차 제한',ok:false,cls:'warn'}
        : {label:'🍼 유아차 미확인',ok:false,cls:'unknown'},
      spot.elevator && {label:'🛗 엘리베이터',ok:true,cls:'ok'},
      spot.restroom_accessible === true ? {label:'🚻 화장실 OK',ok:true,cls:'ok'}
        : spot.restroom_accessible === false ? {label:'🚻 화장실 제한',ok:false,cls:'warn'}
        : {label:'🚻 화장실 미확인',ok:false,cls:'unknown'},
      spot._festival && {label:'🎪 행사',ok:true,cls:'ok'},
    ].filter(Boolean);

    const isLast = idx === spots.length - 1;
    let nextInfo = '';
    if (!isLast) {
      const leg = legs[idx] || estimateLeg(spot, spots[idx + 1]);
      const distKm = leg.route_distance_km || (leg.recommended_distance_m / 1000).toFixed(1);
      // 추천 수단(이동약자 유형 기반)을 강조하고, 모든 수단의 소요 시간을 함께 공개해
      // 사용자가 자신의 체력·동행에 맞춰 다른 수단을 선택할 수 있도록 투명하게 표기한다.
      nextInfo = `
        <div class="tl-time-to-next">
          <div class="tl-time-main">
            <span class="ico" aria-hidden="true">${transportEmoji(leg.recommended_mode)}</span>
            다음까지 약 ${distKm}km · <strong>${escapeHtml(leg.recommended_label)} ${leg.recommended_time_min}분</strong>
            <span class="tl-time-main-hint">(추천)</span>
          </div>
          <div class="tl-time-alt">
            대체 수단 · 🚶 도보 ${leg.walk_time_min}분 · 🚌 대중교통 ${leg.transit_time_min}분 · 🚗 차량 ${leg.car_time_min}분
          </div>
        </div>`;
    }

    const item = document.createElement('div');
    item.className = 'tl-item';
    item.style.cursor = 'pointer';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `${escapeHtml(spot.name)} 상세 보기`);
    item.dataset.spotIdx = idx;
    item.innerHTML = `
      <div class="tl-left"><div class="tl-num">${idx + 1}</div></div>
      <div class="tl-right">
        <div class="name">${escapeHtml(spot.name)}</div>
        <div class="category">${escapeHtml(spot.category)} · 관람 ${spot.visit_time_min}분</div>
        <div class="tl-access-row">${chips.map(c=>`<span class="tl-access-chip ${c.cls||'ok'}">${c.label}</span>`).join('')}</div>
        <p style="font-size:12px;color:var(--gray-500);line-height:1.5;margin-bottom:4px">${escapeHtml(spot.description)}</p>
        ${spot.ai_why || spot.ai_point ? `
        <div class="tl-ai-guide">
          ${spot.ai_why ? `<div class="tl-ai-why"><span class="tl-ai-tag">추천 이유</span> ${escapeHtml(spot.ai_why)}</div>` : ''}
          ${spot.ai_point ? `<div class="tl-ai-point"><span class="tl-ai-tag">감상 포인트</span> ${escapeHtml(spot.ai_point)}</div>` : ''}
        </div>` : ''}
        ${nextInfo}
        <div class="tl-actions">
          <button class="tl-delete-btn" data-idx="${idx}" title="이 장소 제거" aria-label="${escapeHtml(spot.name)} 제거">✕ 제거</button>
          <button class="tl-insert-btn" data-after="${idx}" title="이 위치 다음에 장소 추가" aria-label="다음에 장소 추가">+ 다음에 장소 추가</button>
          <button class="tl-report-btn" data-idx="${idx}" title="현장 접근성 정보 신고" aria-label="${escapeHtml(spot.name)} 현장 정보 알리기">📢 현장 정보 알리기</button>
        </div>
      </div>`;

    item.addEventListener('click', e => {
      const delBtn = e.target.closest('.tl-delete-btn');
      if (delBtn) {
        e.stopPropagation();
        removeSpot(parseInt(delBtn.dataset.idx));
        return;
      }
      const insBtn = e.target.closest('.tl-insert-btn');
      if (insBtn) {
        e.stopPropagation();
        openPlaceSearch(parseInt(insBtn.dataset.after));
        return;
      }
      const repBtn = e.target.closest('.tl-report-btn');
      if (repBtn) {
        e.stopPropagation();
        openReportModal(spots[parseInt(repBtn.dataset.idx)]);
        return;
      }
      showSpotDetail(spot);
    });
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showSpotDetail(spot); }
    });
    return item;
  }

  function renderTimeline(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    spots.forEach((spot, idx) => el.appendChild(buildTimelineItem(spot, idx)));
    // 맨 앞에 장소 추가 버튼
    const prependBtn = document.createElement('button');
    prependBtn.className = 'tl-insert-btn tl-insert-top';
    prependBtn.textContent = '+ 첫 번째에 장소 추가';
    prependBtn.addEventListener('click', () => openPlaceSearch(-1));
    el.prepend(prependBtn);
  }

  function renderAllTimelines() {
    renderTimeline('timelineList');
    renderTimeline('timelineListPc');
  }

  renderOverview();
  renderAllTimelines();

  // ── 6. 지도 초기화 ───────────────────────────────────────────────
  const mapMobile = document.getElementById('mapArea');
  const mapPc     = document.getElementById('mapAreaPc');

  async function initMaps(spotList) {
    if (!spotList || !spotList.length) return;
    await waitForKakaoKey();
    // 유효 좌표만 필터링 (장소 추가 후 좌표 누락 방지)
    const valid = spotList.filter(function (s) {
      return typeof s.lat === 'number' && typeof s.lng === 'number' && !isNaN(s.lat) && !isNaN(s.lng);
    });
    if (!valid.length) return;

    if (window.KAKAO_MAP_KEY) {
      try {
        await loadKakaoSdk();
        if (mapMobile) await renderKakaoMap(valid, mapMobile);
        if (mapPc)     await renderKakaoMap(valid, mapPc);
        return;
      } catch (err) {
        console.warn('Kakao SDK 로드 실패, 요약 지도로 폴백:', err && err.message);
        if (mapMobile) renderMockMap(valid, mapMobile);
        if (mapPc)     renderMockMap(valid, mapPc);
        showToast('지도 SDK를 불러오지 못해 요약 지도로 표시했어요.', 'info');
        return;
      }
    }
    // KAKAO_MAP_KEY 미설정 — 바로 mock
    if (mapMobile) renderMockMap(valid, mapMobile);
    if (mapPc)     renderMockMap(valid, mapPc);
  }

  await initMaps(spots);

  // ── 7. 장소 검색 & 코스 삽입 ────────────────────────────────────
  let insertAfterIdx = -1;   // -1 = 맨 앞에 삽입

  function openPlaceSearch(afterIdx) {
    insertAfterIdx = afterIdx;
    const existing = document.getElementById('placeSearchModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'placeSearchModal';
    modal.className = 'spot-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '장소 검색');
    modal.innerHTML = `
      <div class="spot-modal-inner" style="max-height:80vh;display:flex;flex-direction:column;">
        <button class="spot-modal-close" id="placeSearchClose" aria-label="닫기">✕</button>
        <h3 style="margin-bottom:12px">장소 검색</h3>
        <p style="font-size:13px;color:var(--gray-500);margin-bottom:12px">
          ${afterIdx === -1 ? '맨 앞에' : `${spots[afterIdx]?.name} 다음에`} 삽입됩니다
        </p>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input id="placeSearchInput" type="search" placeholder="예: 해운대 맛집, 광안리 카페…"
            style="flex:1;padding:10px 14px;border:1.5px solid var(--gray-200);border-radius:8px;font-size:14px;outline:none"
            aria-label="장소 검색어">
          <button id="placeSearchBtn" class="btn-primary" style="width:auto;padding:0 16px;font-size:14px">검색</button>
        </div>
        <div id="placeSearchResults" style="flex:1;overflow-y:auto;"></div>
      </div>`;

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    // DOM에 추가된 후 이벤트 바인딩
    document.getElementById('placeSearchClose').addEventListener('click', () => modal.remove());
    const input = document.getElementById('placeSearchInput');
    const btn   = document.getElementById('placeSearchBtn');
    input.focus();

    const doSearch = () => {
      const keyword = input.value.trim();
      if (!keyword) return;
      searchPlaces(keyword);
    };

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  }

  async function searchPlaces(keyword) {
    const resultsEl = document.getElementById('placeSearchResults');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">검색 중…</div>';

    await waitForKakaoKey();

    // KAKAO_MAP_KEY가 없거나 SDK 로드가 실패하는 경우, 즉시 백엔드 fallback으로 전환한다.
    // SDK 로드 자체를 기다리다 지연되는 경우도 있어 선제적으로 처리한다.
    if (!window.KAKAO_MAP_KEY) {
      try { await searchPlacesFallback(keyword); }
      catch (_) {
        resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">장소 검색에 실패했습니다. 다시 시도해주세요.</div>';
      }
      return;
    }

    try {
      await loadKakaoSdk();
    } catch (err) {
      // SDK 로드 실패 시 백엔드 fallback
      try { await searchPlacesFallback(keyword); }
      catch (_) {
        resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">지도 SDK 및 백엔드 검색이 모두 실패했습니다.<br>네트워크를 확인 후 다시 시도해주세요.</div>';
      }
      return;
    }

    if (!window.kakao?.maps?.services) {
      // Places 서비스 미활성화 시 백엔드 API로 직접 폴백
      try { await searchPlacesFallback(keyword); }
      catch (_) {
        if (resultsEl) resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">장소 검색에 실패했습니다. 다시 시도해주세요.</div>';
      }
      return;
    }

    const ps = new kakao.maps.services.Places();
    ps.keywordSearch(keyword, async (data, status) => {
      if (status === kakao.maps.services.Status.OK) {
        renderPlaceResults(data.slice(0, 10));
      } else if (status === kakao.maps.services.Status.ZERO_RESULT) {
        // 결과 없음 시에도 백엔드 fallback으로 재시도해 TourAPI 결과까지 확인
        try { await searchPlacesFallback(keyword); }
        catch (_) {
          resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">검색 결과가 없습니다.</div>';
        }
      } else {
        try { await searchPlacesFallback(keyword); }
        catch (_) {
          if (resultsEl) resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">장소 검색에 실패했습니다. 다시 시도해주세요.</div>';
        }
      }
    }, {
      location: new kakao.maps.LatLng(35.1796, 129.0756),
      radius: 30000,
    });
  }

  async function searchPlacesFallback(keyword) {
    const resultsEl = document.getElementById('placeSearchResults');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">백엔드에서 검색 중…</div>';
    try {
      const res = await fetch(`/api/search-places?keyword=${encodeURIComponent(keyword)}`);
      if (!res.ok) throw new Error('fetch error');
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">검색 결과가 없습니다.</div>';
        return;
      }
      renderPlaceResults(data);
    } catch (err) {
      resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400)">장소 검색에 실패했습니다. 다른 키워드로 다시 시도해주세요.</div>';
    }
  }

  function renderPlaceResults(places) {
    const resultsEl = document.getElementById('placeSearchResults');
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
    places.forEach(place => {
      const item = document.createElement('button');
      item.className = 'place-result-item';
      item.style.cssText = 'width:100%;text-align:left;padding:12px;border:none;border-bottom:1px solid var(--gray-100);background:none;cursor:pointer;border-radius:0;';
      item.innerHTML = `
        <div style="font-size:14px;font-weight:600;color:var(--gray-900);margin-bottom:2px">${escapeHtml(place.place_name)}</div>
        <div style="font-size:12px;color:var(--gray-500)">${escapeHtml(place.category_name)} · ${escapeHtml(place.address_name)}</div>`;
      item.addEventListener('mouseenter', () => item.style.background = '#f5f7ff');
      item.addEventListener('mouseleave', () => item.style.background = 'none');
      item.addEventListener('click', () => insertPlace(place));
      resultsEl.appendChild(item);
    });
  }

  async function insertPlace(place) {
    const newSpot = {
      id: `custom_${Date.now()}`,
      name: place.place_name,
      area: '부산',
      lat: parseFloat(place.y),
      lng: parseFloat(place.x),
      category: place.category_group_name || place.category_name?.split(' > ')[0] || '장소',
      visit_time_min: 40,
      distance_from_prev_m: 0,
      slope_pct: 2.0,
      wait_time_min: 5,
      wheelchair_accessible: true,
      stroller_accessible: true,
      elevator: false,
      restroom_accessible: false,
      accessibility_grade: 3,
      description: place.address_name,
      image_url: null,
      tags: ['직접추가'],
      phone: place.phone || '',
      place_url: place.place_url || '',
      _custom: true,
    };

    // insertAfterIdx 위치에 삽입
    const insertAt = insertAfterIdx + 1;  // -1이면 0(맨 앞)
    spots.splice(insertAt, 0, newSpot);

    // legs 재계산 (삽입 지점 앞뒤)
    rebuildLegs();

    // AppState에 저장
    course.spots = spots;
    course.legs  = legs;
    AppState.selected_course = course;

    // UI 갱신
    renderOverview();
    renderAllTimelines();
    await initMaps(spots);

    document.getElementById('placeSearchModal')?.remove();
    showToast(`"${newSpot.name}"을(를) 코스에 추가했어요.`, 'success');
  }

  function rebuildLegs() {
    legs = [];
    for (let i = 0; i < spots.length - 1; i++) {
      const leg = estimateLeg(spots[i], spots[i + 1]);
      legs.push({
        from_id: spots[i].id,
        to_id: spots[i + 1].id,
        ...leg,
        route_distance_km: (leg.recommended_distance_m / 1000).toFixed(1),
      });
    }
  }

  async function removeSpot(idx) {
    if (spots.length <= 2) {
      showToast('최소 2개 장소는 유지해야 합니다.', 'info');
      return;
    }
    const name = spots[idx].name;
    spots.splice(idx, 1);
    rebuildLegs();
    course.spots = spots;
    course.legs = legs;
    AppState.selected_course = course;
    renderOverview();
    renderAllTimelines();
    await initMaps(spots);
    showToast(`"${name}"을(를) 코스에서 제거했어요.`, 'success');
  }

  // ── 8. 헬퍼 함수 ─────────────────────────────────────────────────
  function haversine(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function estimateLeg(from, to) {
    const dist = haversine(from, to);
    const walkDist = dist * 1.18, transitDist = dist * 1.33, carDist = dist * 1.24;
    const sensitive = (AppState.mobility_types || []).some(t => ['wheelchair','stroller','senior'].includes(t));
    const walkT   = Math.max(3, Math.round(walkDist / 3000 * 60));
    const transitT = Math.max(10, Math.round(transitDist / 18000 * 60 + 8));
    const carT    = Math.max(6, Math.round(carDist / 26000 * 60 + 5));

    let mode, recDist, recTime;
    if (dist <= (sensitive ? 700 : 1000)) {
      [mode, recDist, recTime] = ['walk', walkDist, walkT];
    } else if (dist <= (sensitive ? 2200 : 4500)) {
      [mode, recDist, recTime] = ['transit', transitDist, transitT];
    } else {
      [mode, recDist, recTime] = ['car', carDist, carT];
    }
    return {
      straight_distance_m: Math.round(dist),
      recommended_mode: mode,
      recommended_label: {walk:'도보',transit:'대중교통',car:'차량'}[mode],
      recommended_distance_m: Math.round(recDist),
      recommended_time_min: recTime,
      walk_time_min: walkT, transit_time_min: transitT, car_time_min: carT,
    };
  }

  function transportEmoji(mode) {
    return { walk: '🚶', transit: '🚌', car: '🚗' }[mode] || '📍';
  }

  function showSpotDetail(spot) {
    document.getElementById('spotModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'spotModal';
    modal.className = 'spot-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', `${spot.name} 상세 정보`);
    // 안전한 URL만 허용 (http/https/상대경로) — javascript: 등 차단
    const safeImageUrl = _safeUrl(spot.image_url);
    const safePlaceUrl = _safeUrl(spot.place_url);
    modal.innerHTML = `
      <div class="spot-modal-inner">
        <button class="spot-modal-close" id="spotModalClose" aria-label="닫기">✕</button>
        ${safeImageUrl ? `<div style="margin:-28px -20px 16px;height:180px;overflow:hidden;border-radius:var(--radius-xl) var(--radius-xl) 0 0">
          <img src="${escapeHtml(safeImageUrl)}" alt="${escapeHtml(spot.name)}" style="width:100%;height:100%;object-fit:cover" onerror="this.onerror=null;this.style.display='none';">
        </div>` : ''}
        <h3>${escapeHtml(spot.name)}</h3>
        <div class="spot-modal-category">${escapeHtml(spot.category)} · ${escapeHtml(spot.area)}</div>
        <p class="spot-modal-desc">${escapeHtml(spot.description)}</p>
        <div class="spot-modal-meta">
          <div><span>⏱</span> 관람 ${spot.visit_time_min}분</div>
          <div><span>📐</span> 경사도 ${spot.slope_pct}%</div>
          <div><span>⌛</span> 대기 ${spot.wait_time_min}분</div>
        </div>
        <div class="spot-modal-access">
          ${spot.wheelchair_accessible === true ? '<span class="chip ok">♿ 휠체어 OK</span>' : spot.wheelchair_accessible === false ? '<span class="chip warn">♿ 휠체어 제한</span>' : '<span class="chip unknown">♿ 휠체어 미확인</span>'}
          ${spot.stroller_accessible === true ? '<span class="chip ok">🍼 유아차 OK</span>' : spot.stroller_accessible === false ? '<span class="chip warn">🍼 유아차 제한</span>' : '<span class="chip unknown">🍼 유아차 미확인</span>'}
          ${spot.elevator              ? '<span class="chip ok">🛗 엘리베이터</span>' : ''}
          ${spot.restroom_accessible === true ? '<span class="chip ok">🚻 화장실 OK</span>' : spot.restroom_accessible === false ? '<span class="chip warn">🚻 화장실 제한</span>' : '<span class="chip unknown">🚻 화장실 미확인</span>'}
          ${spot._custom               ? '<span class="chip" style="background:#fff3cd;color:#856404">✏️ 직접 추가</span>' : ''}
        </div>
        ${safePlaceUrl ? `<a href="${escapeHtml(safePlaceUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:12px;font-size:13px;color:var(--primary);text-decoration:none">카카오맵에서 보기 →</a>` : ''}
        <div class="spot-modal-grade">
          접근성 등급: <strong>${gradeLabel(spot.accessibility_grade||3)}</strong>
          (${spot.accessibility_grade||3}/5점)
        </div>
        <div id="spotDetailExtra" style="margin-top:14px"></div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    document.getElementById('spotModalClose')?.addEventListener('click', () => modal.remove());

    // TourAPI detailCommon2/Intro2/Image2 lazy 로드 — spot.id 가 tour_* 형식일 때만
    loadSpotDetail(spot);
  }

  // ── 안전한 URL 허용 목록 ──────────────────────────────────────────
  function _safeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    // 허용: http/https 절대경로 + / 로 시작하는 상대경로
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/')) return trimmed;
    return '';
  }

  async function loadSpotDetail(spot) {
    const container = document.getElementById('spotDetailExtra');
    if (!container) return;
    // 현장 제보 수는 TourAPI 여부와 무관하게 조회 가능
    const reportsPromise = fetch(`/api/reports/${encodeURIComponent(spot.id)}`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);

    const m = /^tour_(\d+)$/.exec(spot.id || '');
    let detailPromise = Promise.resolve(null);
    if (m) {
      const contentId = m[1];
      detailPromise = fetch(`/api/spot-detail/${encodeURIComponent(contentId)}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    }

    const [d, reports] = await Promise.all([detailPromise, reportsPromise]);

    const rows = [];
    if (d) {
      if (d.usetime) rows.push(`<div>🕘 <strong>운영</strong> ${escapeHtml(d.usetime)}</div>`);
      if (d.restdate) rows.push(`<div>📅 <strong>휴무</strong> ${escapeHtml(d.restdate)}</div>`);
      if (d.parking) rows.push(`<div>🅿️ <strong>주차</strong> ${escapeHtml(d.parking)}</div>`);
      if (d.tel) rows.push(`<div>📞 <strong>전화</strong> ${escapeHtml(d.tel)}</div>`);
      const safeHome = _safeUrl(d.homepage);
      if (safeHome) rows.push(`<div>🔗 <a href="${escapeHtml(safeHome)}" target="_blank" rel="noopener noreferrer">홈페이지</a></div>`);
    }

    const reportsCount = Array.isArray(reports) ? reports.length : 0;
    const reportsBanner = reportsCount > 0
      ? `<div style="margin-top:10px;padding:8px 10px;background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:6px;font-size:12.5px;color:#78350F">⚑ 현장 제보 ${reportsCount}건 — 방문 전 최근 접근성 상황을 확인해 주세요</div>`
      : '';

    const gallery = d && Array.isArray(d.images) ? d.images.slice(0, 6).filter(_safeUrl) : [];
    const galleryHtml = gallery.length
      ? `<div style="display:flex;gap:6px;overflow-x:auto;margin-top:10px;padding-bottom:4px">${gallery.map(u => `<img src="${escapeHtml(u)}" alt="추가 이미지" loading="lazy" style="height:80px;border-radius:6px;flex:0 0 auto" onerror="this.onerror=null;this.style.display='none';">`).join('')}</div>`
      : '';

    if (rows.length || galleryHtml || reportsBanner) {
      const rowsHtml = rows.length
        ? `<div style="display:grid;gap:4px;font-size:13px;color:var(--gray-600);line-height:1.5">${rows.join('')}</div>`
        : '';
      container.innerHTML = rowsHtml + reportsBanner + galleryHtml;
    }
  }

  // ── 현장 접근성 신고 모달 ─────────────────────────────────────────
  function openReportModal(spot) {
    document.getElementById('reportModal')?.remove();

    const issueTypes = [
      { value: 'barrier_added', label: '새로운 장애물 발견' },
      { value: 'elevator_broken', label: '엘리베이터 고장' },
      { value: 'restroom_closed', label: '장애인화장실 폐쇄' },
      { value: 'accessible', label: '접근 가능 확인됨' },
      { value: 'other', label: '기타' },
    ];

    const modal = document.createElement('div');
    modal.id = 'reportModal';
    modal.className = 'spot-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '현장 접근성 신고');
    modal.innerHTML = `
      <div class="spot-modal-inner" style="max-height:80vh;display:flex;flex-direction:column;">
        <button class="spot-modal-close" id="reportModalClose" aria-label="닫기">✕</button>
        <h3 style="margin-bottom:4px">현장 정보 알리기</h3>
        <p style="font-size:13px;color:var(--gray-500);margin-bottom:16px">${escapeHtml(spot.name)}</p>
        <label style="font-size:13px;font-weight:600;margin-bottom:6px;display:block">이슈 유형</label>
        <div id="reportIssueTypes" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          ${issueTypes.map(t => `<button class="report-type-btn" data-value="${t.value}" style="padding:8px 14px;border:1.5px solid var(--gray-200);border-radius:20px;background:none;font-size:13px;cursor:pointer;transition:all .2s">${t.label}</button>`).join('')}
        </div>
        <label style="font-size:13px;font-weight:600;margin-bottom:6px;display:block">설명 (선택)</label>
        <textarea id="reportDesc" rows="3" placeholder="현장 상황을 간단히 설명해주세요..."
          style="width:100%;padding:10px 14px;border:1.5px solid var(--gray-200);border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;outline:none;margin-bottom:16px"></textarea>
        <button id="reportSubmitBtn" class="btn-primary" disabled style="opacity:0.5">신고하기</button>
      </div>`;

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    document.getElementById('reportModalClose').addEventListener('click', () => modal.remove());

    let selectedType = '';
    const typeButtons = modal.querySelectorAll('.report-type-btn');
    const submitBtn = document.getElementById('reportSubmitBtn');

    typeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        typeButtons.forEach(b => { b.style.background = 'none'; b.style.borderColor = 'var(--gray-200)'; b.style.color = 'inherit'; });
        btn.style.background = 'var(--primary)';
        btn.style.borderColor = 'var(--primary)';
        btn.style.color = '#fff';
        selectedType = btn.dataset.value;
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
      });
    });

    submitBtn.addEventListener('click', async () => {
      if (!selectedType) return;
      submitBtn.disabled = true;
      submitBtn.textContent = '전송 중...';
      const desc = document.getElementById('reportDesc').value.trim();
      const result = await apiPost('/api/report', {
        spot_id: spot.id,
        spot_name: spot.name,
        issue_type: selectedType,
        description: desc,
        lat: spot.lat,
        lng: spot.lng,
      });
      modal.remove();
      if (result && result.id) {
        showToast('감사합니다! 데이터 개선에 도움이 됩니다.', 'success');
      } else {
        showToast('신고 전송에 실패했습니다. 다시 시도해주세요.', 'error');
      }
    });
  }

  // ── 9. 공유 버튼 + 만족도 조사 모달 ────────────────────────────────
  async function performShare() {
    const result = await apiPost('/api/share', { course_id: course.id, course });
    if (result?.token) {
      AppState.selected_course = course;
      localStorage.setItem('mb_share_token', result.token);
      navigateTo('/share.html?token=' + result.token);
      return;
    }
    showToast('공유 링크 생성에 실패했습니다.', 'error');
  }

  function performBackToResults() {
    navigateTo('/results.html');
  }

  // 만족도 모달 노출 후 원래 액션 실행 (onclick 직접 할당으로 재진입 안전)
  function showSatisfactionModal(afterAction) {
    const modal = document.getElementById('satisfactionModal');
    if (!modal) { afterAction(); return; }

    // 이미 제출한 경우 바로 패스
    if (sessionStorage.getItem('mb_survey_done') === '1') {
      afterAction();
      return;
    }

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    const scaleEl = document.getElementById('satisfactionScale');
    const panelEl = document.getElementById('satisfactionReasonPanel');
    const chipsEl = document.getElementById('satisfactionReasonChips');
    const textEl = document.getElementById('satisfactionText');
    const countEl = document.getElementById('satisfactionCharCount');
    const submitEl = document.getElementById('satisfactionSubmit');
    const skipEl = document.getElementById('satisfactionSkip');
    const doneEl = document.getElementById('satisfactionDone');
    const backdropEl = document.getElementById('satisfactionBackdrop');
    const actionsEl = modal.querySelector('.satisfaction-actions');

    // 상태 초기화 (재진입 대비)
    let selectedScore = 0;
    scaleEl.querySelectorAll('.satisfaction-btn').forEach(b => b.setAttribute('aria-checked', 'false'));
    chipsEl.querySelectorAll('.satisfaction-reason-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    if (textEl) textEl.value = '';
    if (countEl) countEl.textContent = '0';
    submitEl.disabled = true;
    if (scaleEl) scaleEl.style.display = '';
    if (actionsEl) actionsEl.style.display = '';
    if (doneEl) doneEl.hidden = true;
    panelEl.classList.remove('open');
    panelEl.setAttribute('aria-hidden', 'true');

    function openReasonPanel(open) {
      if (open) {
        panelEl.classList.add('open');
        panelEl.setAttribute('aria-hidden', 'false');
      } else {
        panelEl.classList.remove('open');
        panelEl.setAttribute('aria-hidden', 'true');
      }
    }

    function cleanup() {
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }

    // 점수 버튼: onclick 직접 할당 (addEventListener 누적 방지)
    scaleEl.querySelectorAll('.satisfaction-btn').forEach(btn => {
      btn.onclick = function () {
        const score = parseInt(this.dataset.score, 10);
        selectedScore = score;
        scaleEl.querySelectorAll('.satisfaction-btn').forEach(b => {
          b.setAttribute('aria-checked', b === this ? 'true' : 'false');
        });
        submitEl.disabled = false;
        openReasonPanel(score <= 2);
      };
    });

    // 사유 칩
    chipsEl.querySelectorAll('.satisfaction-reason-chip').forEach(chip => {
      chip.onclick = function () {
        const pressed = this.getAttribute('aria-pressed') === 'true';
        this.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      };
    });

    // 텍스트 카운터
    if (textEl && countEl) {
      textEl.oninput = function () {
        countEl.textContent = String(this.value.length);
      };
    }

    // 제출
    submitEl.onclick = async function () {
      if (!selectedScore) return;
      submitEl.disabled = true;
      const selectedReasons = Array.from(chipsEl.querySelectorAll('.satisfaction-reason-chip[aria-pressed="true"]')).map(c => c.dataset.reason);
      const text = textEl ? textEl.value.trim() : '';
      const res = typeof submitSatisfactionSurvey === 'function'
        ? await submitSatisfactionSurvey(selectedScore, selectedReasons, text)
        : { ok: false };
      if (res && res.ok) {
        sessionStorage.setItem('mb_survey_done', '1');
        scaleEl.style.display = 'none';
        openReasonPanel(false);
        if (actionsEl) actionsEl.style.display = 'none';
        if (doneEl) doneEl.hidden = false;
        setTimeout(() => {
          cleanup();
          afterAction();
        }, 1500);
      } else {
        submitEl.disabled = false;
        showToast('의견 저장에 실패했어요. 잠시 후 다시 시도해주세요.', 'error');
      }
    };

    // 건너뛰기
    skipEl.onclick = function () {
      sessionStorage.setItem('mb_survey_done', '1');
      cleanup();
      afterAction();
    };

    // 백드롭 클릭 = 건너뛰기
    if (backdropEl) {
      backdropEl.onclick = function () {
        sessionStorage.setItem('mb_survey_done', '1');
        cleanup();
        afterAction();
      };
    }
  }

  // 공유 버튼에 만족도 조사 래핑
  ['shareBtn','shareAction','shareActionPc'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      showSatisfactionModal(() => performShare());
    });
  });

  // "다른 코스 보기" + 헤더 뒤로가기 버튼에도 만족도 조사 래핑
  ['backBtnHeader', 'backToResults','backToResultsPc'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      showSatisfactionModal(() => performBackToResults());
    });
  });
})();
