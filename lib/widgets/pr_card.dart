/// 掲示板・一覧における広告の論理配置区分。
/// 実際の広告Widgetは NativeAdCard / NewsBannerAd 等が担う。
enum AdPlacement {
  postContribution, // 投稿直後枠
  normalComment, // 通常コメント枠
  newsListBanner, // 一覧バナー枠
  newsListTopInFeed, // 一覧トップインフィード枠
  newsListInFeed, // 一覧一般インフィード枠
}
