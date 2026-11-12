/** Host-initiated cloud closes carry a code the user can act on. */
export function cloudCloseNotice(code: number | null): string {
  if (code === 4403) {
    return '当前连接已被管理员收回，请重新登录或联系平台管理员。'
  }
  if (code === 4431) {
    return '并发连接数已达上限，请先关闭其他会话后再试。'
  }
  return '连接已断开，请重新打开项目。'
}
