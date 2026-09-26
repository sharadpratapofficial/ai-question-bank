const https = require('https');

const data = JSON.stringify({
  model: "gpt-4o",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { 
          type: "file",
          file: {
            filename: "test.pdf",
            file_data: "data:application/pdf;base64,JVBERi0xLjQK"
          }
        }
      ]
    }
  ]
});

const options = {
  hostname: 'api.openai.com',
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer sk-fake-key-12345'
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => { console.log("Status:", res.statusCode, "Body:", body); });
});
req.on('error', (e) => { console.error(e); });
req.write(data);
req.end();
