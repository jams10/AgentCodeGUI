//! **보드 스토어(boards/)** — 자리 배치. M-UX §4.1의 "`chats-v3/`의 복제".
//!
//! ```text
//! boards/
//!   index.json      { version, order[], activeBoardId }
//!   <boardId>.json  { id, title, custom, count, chrome, order, slots, updatedAt }
//! ```
//!
//! 2.6.2 `PersistedSession`(MultiAgent.tsx:139-158)의 후신이다. 다른 점 셋:
//!  - **패널 스냅샷을 담지 않는다.** 대화는 전부 `chats-v3/`에 있고 보드는 `slots[i] = chatId`만
//!    든다 → `ma.rs`의 unloaded 마커 병합(대화 증발의 두 번째 자리)이 **구조적으로 사라진다.**
//!  - `panelOrder` → `order`, `chrome`(`'ide' | 'grid'`) 추가(M9 전용 뷰의 확장점).
//!  - 파일이 작아(수백 바이트) light 조회가 필요 없다.

use serde_json::{json, Map, Value};

use crate::fanout::{safe_id, version_or_1, Fanout};

pub const DIR: &str = "boards";
/// ★3.3 페이지 — 자리 12개를 6개씩 두 페이지로 본다(렌더러 `MultiAgent.tsx` PAGE_SIZE/PAGE_COUNT와 짝).
/// 슬롯 0‥5 = 1페이지(`count`·`promo`), 6‥11 = 2페이지(`count2`·`promo2`). `page` = 마지막으로 보던 페이지.
pub const PAGE_SIZE: usize = 6;
pub const PAGE_COUNT: usize = 2;
pub const SLOT_COUNT: usize = PAGE_SIZE * PAGE_COUNT;

pub fn page_of(slot: usize) -> usize {
    slot / PAGE_SIZE
}

/// 보드의 페이지 `p` 자리 수 — 1페이지는 `count`, 2페이지는 `count2`(없으면 count를 따른다). 1‥PAGE_SIZE.
pub fn page_count(board: &Value, p: usize) -> usize {
    let c1 = board.get("count").and_then(Value::as_u64).unwrap_or(1);
    let c = if p == 0 { c1 } else { board.get("count2").and_then(Value::as_u64).unwrap_or(c1) };
    c.clamp(1, PAGE_SIZE as u64) as usize
}

static STORE: Fanout = Fanout::new(DIR, &["index.json"]);

pub fn dir_path() -> std::path::PathBuf {
    STORE.dir_path()
}
pub fn invalidate() {
    STORE.invalidate();
}

pub fn read_boards() -> Value {
    // ★3.0.3 — 캐시판. 허브가 슬롯마다 20ms 틱에서 부르는 자리(`panel_seat_for_chat`)라
    // 매 호출이 index + 보드 파일 전부를 읽고 파싱하던 것이 「점점 느려짐」의 첫 원인이었다.
    let Some((index, boards)) = STORE.read_all_cached() else { return Value::Null };
    json!({
        "version": version_or_1(&index),
        "boards": Value::Array(boards.as_ref().clone()),
        "activeBoardId": index.get("activeBoardId").and_then(Value::as_str).unwrap_or(""),
    })
}

/// ★3.0.5 — 보드 배열을 **복제 없이** 빌려준다. 허브가 슬롯마다 틱마다 부르는 자리
/// (`engine::panel_seat_of`)용 — `read_boards`는 호출마다 전 보드를 깊이 복제한다.
pub fn with_boards<R>(f: impl FnOnce(&[Value]) -> R) -> Option<R> {
    let (_, boards) = STORE.read_all_cached()?;
    Some(f(boards.as_ref()))
}

pub fn read_board(id: &Value) -> Value {
    match safe_id(id) {
        Some(id) => STORE.read_one(id),
        None => Value::Null,
    }
}

pub fn write_boards(data: &Value) {
    let Some(boards) = data.get("boards").and_then(Value::as_array) else { return };
    let mut extra = Map::new();
    extra.insert("version".into(), version_or_1(data));
    extra.insert(
        "activeBoardId".into(),
        json!(data.get("activeBoardId").and_then(Value::as_str).unwrap_or("")),
    );
    STORE.write_all(boards, &extra, |_id, b| b.clone());
}

/// 활성 보드의 **보이는 자리**(order 앞 count개)에 얹힌 채팅들 — light 조회의 (a).
/// 접힌 자리(`order.slice(count)`)는 포함하지 않는다: 스냅샷을 안 실어도 상태 점·배지는
/// `status.json`이 그린다(§4.3의 표).
pub fn visible_chat_ids() -> Vec<String> {
    let Some(index) = STORE.read_index() else { return vec![] };
    let Some(active) = index.get("activeBoardId").and_then(Value::as_str) else { return vec![] };
    let Some(board) = STORE.stored(active) else { return vec![] };
    let empty = vec![];
    let slots = board.get("slots").and_then(Value::as_array).unwrap_or(&empty);
    let order = sanitize_order(board.get("order"));
    let mut out = Vec::new();
    // ★3.3 페이지마다 "그 페이지 부분열의 앞 count개" — 숨은 페이지의 보이는 자리도 돌 수 있으니 포함
    for p in 0..PAGE_COUNT {
        let count = page_count(&board, p);
        for slot in order.iter().copied().filter(|s| page_of(*s) == p).take(count) {
            if let Some(Value::String(id)) = slots.get(slot) {
                if !id.is_empty() {
                    out.push(id.clone());
                }
            }
        }
    }
    out
}

fn is_permutation(got: &[usize], n: usize) -> bool {
    if got.len() != n {
        return false;
    }
    let mut seen = vec![false; n];
    for &i in got {
        if i >= n || seen[i] {
            return false;
        }
        seen[i] = true;
    }
    true
}

/// 자리 순열 위생 — 0..SLOT_COUNT의 순열이 아니면 기본 순서(2.6.2 `sanitizePanelOrder` 파리티).
/// ★3.3 1페이지만 있던 구 저장본(0..PAGE_SIZE의 순열)은 뒤에 2페이지 슬롯을 기본 순서로 이어 붙인다.
pub fn sanitize_order(v: Option<&Value>) -> Vec<usize> {
    let def: Vec<usize> = (0..SLOT_COUNT).collect();
    let Some(a) = v.and_then(Value::as_array) else { return def };
    let got: Vec<usize> = a.iter().filter_map(Value::as_u64).map(|x| x as usize).collect();
    if is_permutation(&got, SLOT_COUNT) {
        return got;
    }
    if is_permutation(&got, PAGE_SIZE) {
        let mut out = got;
        out.extend(PAGE_SIZE..SLOT_COUNT);
        return out;
    }
    def
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_home;

    fn seed(h: &crate::testkit::Home) {
        h.write(
            "boards/b1.json",
            &json!({ "id": "b1", "count": 2, "chrome": "grid", "order": [3, 1, 0, 2, 4, 5],
                     "slots": ["c-a", "c-b", "c-c", "c-d", Value::Null, Value::Null] })
            .to_string(),
        );
        h.write("boards/index.json", r#"{"version":1,"order":["b1"],"activeBoardId":"b1"}"#);
        invalidate();
    }

    #[test]
    fn visible_chat_ids_follows_the_order_permutation_not_the_slot_index() {
        let h = temp_home("boards-visible");
        seed(&h);
        // order 앞 count(2)개 = 자리 3, 1 → 'c-d', 'c-b' (접힌 자리는 스냅샷을 안 싣는다)
        assert_eq!(visible_chat_ids(), vec!["c-d".to_string(), "c-b".to_string()]);
    }

    #[test]
    fn a_broken_board_index_still_lists_the_boards() {
        let h = temp_home("boards-broken");
        seed(&h);
        h.write("boards/index.json", "{{{");
        invalidate();
        let blob = read_boards();
        assert_eq!(blob["boards"].as_array().map(Vec::len), Some(1), "보드 목록이 전멸했다");
    }

    #[test]
    fn writing_a_subset_while_the_index_is_broken_keeps_the_other_board_files() {
        let h = temp_home("boards-prune-gate");
        seed(&h);
        h.write("boards/b2.json", &json!({ "id": "b2", "count": 1, "slots": [] }).to_string());
        h.write("boards/index.json", "not json");
        invalidate();
        write_boards(&json!({ "version": 1, "activeBoardId": "b1", "boards": [{ "id": "b1", "count": 1, "slots": [] }] }));
        assert!(h.path("boards/b2.json").is_file(), "인덱스를 못 믿는데 보드 파일을 지웠다");
    }

    #[test]
    fn order_sanitizer_rejects_anything_that_is_not_a_permutation() {
        let def: Vec<usize> = (0..SLOT_COUNT).collect();
        // ★3.3 구 저장본(1페이지 6칸 순열)은 2페이지 슬롯을 기본 순서로 이어 붙인다
        assert_eq!(sanitize_order(Some(&json!([5, 4, 3, 2, 1, 0]))), vec![5, 4, 3, 2, 1, 0, 6, 7, 8, 9, 10, 11]);
        assert_eq!(sanitize_order(Some(&json!([11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))), vec![11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert_eq!(sanitize_order(Some(&json!([0, 0, 1, 2, 3, 4]))), def);
        assert_eq!(sanitize_order(Some(&json!([0, 1, 2]))), def);
        assert_eq!(sanitize_order(None), def);
    }

    #[test]
    fn visible_chat_ids_covers_the_second_page_with_its_own_count() {
        let h = temp_home("boards-visible-page2");
        h.write(
            "boards/b1.json",
            &json!({ "id": "b1", "count": 1, "count2": 2, "chrome": "grid",
                     "order": [0, 1, 2, 3, 4, 5, 7, 6, 8, 9, 10, 11],
                     "slots": ["c-a", "c-b", Value::Null, Value::Null, Value::Null, Value::Null,
                               "c-g", "c-h", "c-i", Value::Null, Value::Null, Value::Null] })
            .to_string(),
        );
        h.write("boards/index.json", r#"{"version":1,"order":["b1"],"activeBoardId":"b1"}"#);
        invalidate();
        // 1페이지 앞 1개(자리 0) + 2페이지 앞 2개(자리 7, 6) — 접힌 c-b·c-i는 제외
        assert_eq!(visible_chat_ids(), vec!["c-a".to_string(), "c-h".to_string(), "c-g".to_string()]);
    }
}
