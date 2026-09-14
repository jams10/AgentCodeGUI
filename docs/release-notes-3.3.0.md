## AgentCodeGUI 3.3.0

멀티 채팅이 6칸 페이지 두 개, 최대 12패널이 됐습니다. 여러 패널이 동시에 답을 쓸 때의 끊김도 크게 줄였습니다.

- **페이지 1·2 — 패널 12개** — 헤더의 [1] [2]로 6칸짜리 페이지 둘을 오갑니다. 자리 수(1~6)·접힘·순서는 페이지마다 따로 기억하고, 번호는 두 페이지 모두 1부터 셉니다. 보고 있지 않은 페이지의 패널도 계속 실행되며, 실행 중이면 페이지 버튼에 노란 점, 승인·질문을 기다리면 파란 점이 켜집니다. 알림을 누르면 그 패널이 있는 페이지와 자리로 바로 갑니다. Ctrl+Tab으로도 넘길 수 있고, 예전 6칸 배치는 그대로 1페이지가 됩니다.
- **여러 패널이 동시에 답할 때 덜 끊김** — 답이 흘러들어올 때마다 말풍선 전체를 다시 그리던 것을, 이미 굳은 앞부분은 두고 자라는 꼬리만 다시 그리도록 바꿨습니다. 스크롤을 바닥에 붙이는 방식도 매 프레임 확인에서 내용이 자랄 때만 붙이는 방식으로 바꿨습니다. 12패널이 동시에 답을 쓰는 상황(60토큰/초) 실측: 프레임 작업 시간 p95 29.9 → 9.3 ms, 16.6 ms를 넘긴 프레임 11.3% → 0.7%, 드랍 프레임 7.2% → 2.6%. 완성된 답변의 모양은 전과 같습니다.

---

## AgentCodeGUI 3.3.0 (English)

Multi chat now has two pages of six panels, up to twelve in one board, and streaming in many panels at once stutters far less.

- **Pages 1 and 2 — twelve panels** — Switch between two six-panel pages with [1] [2] in the header. Panel count (1–6), folding, and order are remembered per page, and numbering starts at 1 on both pages. Panels on the page you are not looking at keep running; the page button shows an amber dot while something runs there and a blue dot when a panel waits for approval or an answer. Clicking a notification jumps to that panel's page and seat. Ctrl+Tab switches pages too, and an existing six-panel layout simply becomes page 1.
- **Less stutter while many panels stream** — Each streamed chunk used to re-render the whole message; now the settled part stays put and only the growing tail is redrawn. Bottom-following moved from a per-frame check to reacting only when content actually grows. Measured with twelve panels streaming at once (60 tokens/s): frame work p95 29.9 → 9.3 ms, frames over 16.6 ms 11.3% → 0.7%, dropped frames 7.2% → 2.6%. Finished messages look exactly as before.

