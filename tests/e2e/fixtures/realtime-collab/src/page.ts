/** One document: a socket for edits, an event stream for who edited it. */
export const page = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Realtime collab</title></head>
  <body>
    <main>
      <p>Socket: <span id="ws-status">connecting</span></p>
      <p>Feed: <span id="sse-status">connecting</span></p>
      <pre id="content"></pre>
      <form id="edit">
        <label>Text <input id="text" name="text"></label>
        <button type="submit">Send edit</button>
      </form>
      <p id="denied"></p>
      <ul id="activity"></ul>
    </main>
    <script type="module">
      const params = new URLSearchParams(location.search);
      const base = '/' + params.get('org') + '/docs/' + params.get('doc');
      const $ = (id) => document.getElementById(id);

      const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + base + '/ws');
      ws.addEventListener('open', () => { $('ws-status').textContent = 'open'; });
      ws.addEventListener('close', (event) => {
        $('ws-status').textContent = 'closed ' + event.code + ' ' + event.reason;
      });
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'doc') { $('content').textContent = message.text; }
        if (message.type === 'denied') { $('denied').textContent = 'Denied: ' + message.reason; }
      });
      $('edit').addEventListener('submit', (event) => {
        event.preventDefault();
        ws.send(JSON.stringify({ text: $('text').value }));
      });

      const feed = new EventSource(base + '/events');
      let ended = false;
      feed.addEventListener('ready', () => { $('sse-status').textContent = 'open'; });
      feed.addEventListener('message', (event) => {
        const edit = JSON.parse(event.data);
        const item = document.createElement('li');
        item.textContent = edit.by + ' edited ' + edit.docId;
        $('activity').append(item);
      });
      feed.addEventListener('permdock', (event) => {
        ended = true;
        feed.close();
        $('sse-status').textContent = 'revoked ' + JSON.parse(event.data).detail;
      });
      feed.addEventListener('error', () => {
        if (!ended) { feed.close(); $('sse-status').textContent = 'error'; }
      });
    </script>
  </body>
</html>
`;
