// Script de prueba para verificar conectividad TCP
import net from "net";

const SERVER_IP = "148.230.83.171";
const SERVER_PORT = 6808;
const TEST_IMEI = "351258730074555";

console.log(`🔍 Testing connection to ${SERVER_IP}:${SERVER_PORT}...`);

const client = net.createConnection(SERVER_PORT, SERVER_IP, () => {
  console.log(`✅ Connected to server!`);
  
  // Send test LK message
  const testMessage = `[3G*${TEST_IMEI}*0009*LK,0,0,21]`;
  console.log(`📤 Sending: ${testMessage}`);
  client.write(testMessage);
});

client.on("data", (data) => {
  console.log(`📥 Received: ${data.toString()}`);
  client.end();
});

client.on("error", (err) => {
  console.error(`❌ Connection error:`, err.message);
  if (err.code === "ECONNREFUSED") {
    console.error("   → Server is not accepting connections (check if server is running)");
  } else if (err.code === "ETIMEDOUT") {
    console.error("   → Connection timeout (check firewall and network)");
  } else if (err.code === "EHOSTUNREACH") {
    console.error("   → Host unreachable (check IP address)");
  }
  process.exit(1);
});

client.on("close", () => {
  console.log(`🔌 Connection closed`);
  process.exit(0);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.error("❌ Connection timeout");
  client.destroy();
  process.exit(1);
}, 10000);

