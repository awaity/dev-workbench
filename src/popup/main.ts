import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import Popup from './Popup.vue';
import './popup.scss';

/**
 * 浏览器完成弹窗初始测量后收敛实际高度，避免小屏幕产生额外的滚动条留白。
 * @returns 无返回值。
 */
function fitPopupHeight(): void {
  // Chrome 初始视口可能只有 25px，先由固定高度撑开，再接收浏览器给出的可用高度。
  if (window.innerHeight >= 300) {
    document.documentElement.style.setProperty(
      '--popup-height',
      `${Math.min(580, window.innerHeight)}px`,
    );
  }
}
// 浏览器初始弹窗很窄，固定实际 action popup 的宽度，避免响应式规则阻止自动撑开。
if (
  typeof chrome !== 'undefined' &&
  chrome.extension?.getViews({ type: 'popup' }).includes(window)
) {
  document.documentElement.classList.add('extension-popup');
  window.addEventListener('resize', fitPopupHeight);
  requestAnimationFrame(() => {
    requestAnimationFrame(fitPopupHeight);
  });
}
createApp(Popup).use(ElementPlus, { locale: zhCn }).mount('#app');
