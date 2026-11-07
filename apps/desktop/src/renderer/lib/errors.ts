/** Human-readable titles for the stable error codes returned by the core. */
export function errorTitle(code: string): string {
  switch (code) {
    case "NOT_A_REPOSITORY": return "这个文件夹不是 Git 仓库";
    case "REPOSITORY_UNAVAILABLE": return "无法访问这个目录";
    case "GIT_UNAVAILABLE": return "未找到系统 Git";
    case "MISSING_OBJECT": return "仓库里缺少需要的对象";
    case "UNSUPPORTED_REPOSITORY": return "暂不支持这种仓库";
    case "RESOURCE_LIMIT": return "内容超出读取上限";
    case "TIMEOUT": return "读取超时";
    case "CANCELLED": return "读取已取消";
    case "INVALID_REQUEST": return "路径无效";
    default: return "读取失败";
  }
}
