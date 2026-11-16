/**
 * 验证脚本共用的开发服务器探测/启动逻辑。
 *
 * 如果 PORT 已经有服务在跑就直接复用，否则自动启动 Vite，
 * 并在验证进程退出时关闭自己启动的实例。
 */
import { spawn } from 'node:child_process'
import { PORT } from './_port.mjs'

const URL = `http://127.0.0.1:${PORT}/`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function reachable() {
  try {
    const res = await fetch(URL)
    return res.ok
  } catch {
    return false
  }
}

export async function ensureServer() {
  if (await reachable()) return null
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  )
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(`开发服务器启动失败（端口 ${PORT}）`)
    if (await reachable()) {
      child.unref()
      process.on('exit', () => {
        if (!exited) child.kill()
      })
      return child
    }
    await sleep(250)
  }
  child.kill()
  throw new Error(`开发服务器启动超时（端口 ${PORT}）`)
}
