// Супервизор preview-стенда SITEE: держит server.mjs живым и не даёт ему умереть.
//
// Зачем: если процесс падает из-за необработанной ошибки, preview-страница
// висит на «вечной загрузке», и пользователь видит «превью не грузится».
// Супервизор перезапускает сервер в течение секунды, а keep-alive пинг раз в
// 30 секунд не даёт хост-платформе усыпить песочницу.
//
// Запуск: node supervisor.mjs   (окружение как у server.mjs: SITEED_*)
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? process.env.ADDR?.split(':').pop() ?? 8080);
const KEEPALIVE_MS = 30_000;

let child = null;
let stopping = false;
let restarts = 0;

function start() {
  if (stopping) return;
  child = spawn(process.execPath, ['server.mjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    restarts += 1;
    console.error(`[supervisor] server.mjs завершился (code=${code}, signal=${signal}) — перезапуск #${restarts} через 1 с`);
    setTimeout(start, 1000);
  });
}

// Keep-alive: лёгкий запрос к healthz держит соединение и платформу бодрыми.
setInterval(async () => {
  try {
    await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) });
  } catch {
    // Сервер в процессе перезапуска — не страшно.
  }
}, KEEPALIVE_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[supervisor] необработанное исключение:', err?.message ?? err);
});

console.log(`[supervisor] запускаю server.mjs на порту ${PORT}, keep-alive ${KEEPALIVE_MS / 1000} с`);
start();
