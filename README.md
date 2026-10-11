# 분식팡

분식 매치3 퍼즐. 모드: **쌓이기**(새 줄이 쌓이는 서바이벌) · **스테이지**(60초 타임어택) · **같이 하기**(2~4명 온라인 대결).

## 혼자 하기
`index.html`만 열면 된다(서버 없이 GitHub Pages 같은 정적 호스팅도 가능).

## 같이 하기 서버
같이 하기는 `server.js`(Node + ws)가 필요하다. 서버는 방 / 시작 시드 / 점수만 중계하고, 게임은 각자 브라우저에서 돈다.

```bash
npm install
npm start        # http://localhost:8080  (PORT 환경변수로 바꿈)
```

- 서버가 `index.html`도 같이 서빙하므로, 같은 주소로 접속하면 WebSocket 주소가 자동으로 맞춰진다.
- Render 배포: Web Service, Build `npm install`, Start `npm start`.
- GitHub Pages 등 다른 곳에 페이지를 올렸다면 `index.html`의 `MP_REMOTE`를 서버 주소(`wss://...`)로 바꾼다.
- 개인전 2~4명, 팀전은 4명이 2:2일 때만 시작할 수 있다. 초대 링크: `?room=코드`.
