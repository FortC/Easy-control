// 上游 @lucasygu/redbook 0.8.2 未附带类型声明，此处声明本适配器实际使用的最小面。
// 版本固定 0.8.2；升级必须重新审查（docs/construction-plan.zh-CN.md §3）。
declare module "@lucasygu/redbook" {
  export interface XhsCookies {
    a1: string;
    web_session: string;
    webId?: string;
    [key: string]: string | undefined;
  }

  export interface XhsUploadPermit {
    fileId: string;
    token: string;
    [key: string]: unknown;
  }

  export interface XhsCreateNoteOptions {
    topics?: { id: string; name: string; type?: string }[];
    ats?: { userId: string; nickname: string }[];
    /** 定时发布时间字符串；不传为立即发布。首期定时由本系统调度，不使用该参数。 */
    postTime?: string;
    isPrivate?: boolean;
  }

  export class XhsClient {
    constructor(cookies: XhsCookies, platform?: "xhs" | "rednote");
    getSelfInfo(): Promise<{ user_id?: string; nickname?: string; red_id?: string } & Record<string, unknown>>;
    getUploadPermit(fileType: "image" | "video", count?: number): Promise<XhsUploadPermit>;
    uploadFile(fileId: string, token: string, filePath: string, contentType?: string): Promise<void>;
    createImageNote(
      title: string,
      desc: string,
      imageFileIds: string[],
      options?: XhsCreateNoteOptions,
    ): Promise<Record<string, unknown>>;
    searchTopics(keyword: string): Promise<{ id: string; name: string }[]>;
    getNoteById(noteId: string, xsecToken?: string, xsecSource?: string): Promise<Record<string, unknown>>;
  }
}
