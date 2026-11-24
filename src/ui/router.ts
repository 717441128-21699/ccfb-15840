/** 简易 Tab 路由器,四个页面懒挂载、切换时卸载释放音频订阅 */

export interface Page {
  mount(): void;
  unmount(): void;
}

export type PageId = 'measure' | 'curve' | 'tune' | 'archive';
