// workspace-fn 이 함께 쓰는 오류 모양 — index.ts 와 admin.ts 가 같은 상태 코드로 답합니다.
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = '') {
    super(message);
    this.status = status;
    this.code = code || String(status);
  }
}
