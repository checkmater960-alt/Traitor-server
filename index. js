const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Traitor Server is Running!\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('✅ Ek Agent / Traitor server se connect ho gaya!');
  ws.on('message', (message) => {
    console.log('📩 Message mila:', message);
    ws.send(message);
  });
  ws.on('close', () => console.log('❌ Connection cut ho gaya.'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Traitor Custom Server port ${PORT} par chalu ho gaya hai!`);
});
