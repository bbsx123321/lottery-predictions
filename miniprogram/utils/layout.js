/**
 * 屏幕布局信息。
 *
 * 高度用 px（安全区是物理像素，不适合用 rpx 换算），其余间距用 rpx。
 */
const NAV_BAR_HEIGHT = 44;

function getLayout() {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const safeArea = info.safeArea || null;

  return {
    // 顶部：状态栏 + 导航栏
    safeTop: (info.statusBarHeight || 20) + NAV_BAR_HEIGHT,
    // 底部：Home Indicator 区
    safeBottom: safeArea ? Math.max(0, info.screenHeight - safeArea.bottom) : 0,
    windowWidth: info.windowWidth,
    windowHeight: info.windowHeight,
    // 1rpx 等于多少 px
    rpxRatio: info.windowWidth / 750,
  };
}

module.exports = {
  getLayout: getLayout,
  NAV_BAR_HEIGHT: NAV_BAR_HEIGHT,
};
