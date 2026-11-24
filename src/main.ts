import './styles.css';
import { store } from './state/store';
import { Page, PageId } from './ui/router';
import { MeasurePage } from './ui/measure-page';
import { CurvePage } from './ui/curve-page';
import { TunePage } from './ui/tune-page';
import { ArchivePage } from './ui/archive-page';
import { session } from './audio/session';

const pageHost = document.getElementById('pageHost')!;
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const subtitle = document.getElementById('pianoSubtitle')!;
const demoToggle = document.getElementById('demoMode') as HTMLInputElement;

const pageBuilders: Record<PageId, (host: HTMLElement) => Page> = {
  measure: (h) => new MeasurePage(h),
  curve: (h) => new CurvePage(h),
  tune: (h) => new TunePage(h),
  archive: (h) => new ArchivePage(h),
};

let current: Page | null = null;
let currentId: PageId | null = null;

function navigate(id: PageId): void {
  if (current) current.unmount();
  pageHost.replaceChildren();
  current = pageBuilders[id](pageHost);
  currentId = id;
  current.mount();
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.page === id));
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    navigate(tab.dataset.page as PageId);
  });
});

// 演示模式开关:切换时重启音频会话
demoToggle.checked = store.settings.demoMode;
demoToggle.addEventListener('change', async () => {
  store.updateSettings({ demoMode: demoToggle.checked });
  await session.stop();
  if (currentId) navigate(currentId);
});

// 档案变化时刷新副标题
function refreshSubtitle(): void {
  const p = store.currentPiano();
  const n = store.currentMeasurements().length;
  subtitle.textContent = p
    ? `${p.name} · ${p.kind} · 已测 ${n} 键`
    : '未选择钢琴档案';
}
store.subscribe(refreshSubtitle);
refreshSubtitle();

// 默认选中第一台预置琴,方便直接演示
if (!store.selectedPianoId) {
  const first = store.allPianos()[0];
  if (first) store.selectPiano(first.id);
}

navigate('measure');

// 调试/测试钩子
declare global {
  interface Window {
    pianoTuner: {
      store: typeof store;
      session: typeof session;
    };
  }
}
window.pianoTuner = { store, session };
