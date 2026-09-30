/// ニュースカテゴリの表示件数とスクロール世代を管理する状態クラス。
/// 通信やChangeNotifierには依存せず、純粋な状態保持と更新ロジックのみを担う。
class NewsCategoryViewState {
  static const int defaultPageSize = 50;
  static const Set<String> managedCategories = {
    'トレンド',
    'エンタメ',
    'サブカル',
    'マネー',
    'IT・ガジェット',
  };

  final Map<String, int> _visibleCounts = {};
  final Map<String, int> _scrollVersions = {};

  /// 指定したカテゴリの現在の表示件数を取得する。
  /// 運営カテゴリ以外（RSSなど）は全件表示されるべきなため、大きな値を返さないよう、
  /// 呼び出し側で対象外判定を行うための 0 または defaultPageSize を返す。
  int getVisibleCount(String category) {
    if (!managedCategories.contains(category)) {
      return 0; // 運営外は段階表示を適用しない
    }
    return _visibleCounts[category] ?? defaultPageSize;
  }

  /// 指定したカテゴリの表示件数をページサイズ分増やす。
  void loadMore(String category, int totalAvailable) {
    if (!managedCategories.contains(category)) return;

    final current = getVisibleCount(category);
    if (current < totalAvailable) {
      _visibleCounts[category] = current + defaultPageSize;
    }
  }

  /// 指定したカテゴリのスクロール世代（PageStorageKeyに使用）を取得する。
  int getScrollVersion(String category) {
    return _scrollVersions[category] ?? 0;
  }

  /// 手動更新時に表示状態をリセットする。
  /// 運営カテゴリの表示件数を初期値に戻し、渡されたすべてのカテゴリのスクロール世代を進める。
  void resetForRefresh(List<String> allCategories) {
    // 運営カテゴリの表示件数をリセット
    for (final category in allCategories.where(managedCategories.contains)) {
      _visibleCounts[category] = defaultPageSize;
    }

    // スクロール位置リセット対象（運営カテゴリ + RSS）の世代を更新
    for (final category in allCategories) {
      if (managedCategories.contains(category) || category == 'RSS') {
        _scrollVersions[category] = (_scrollVersions[category] ?? 0) + 1;
      }
    }
  }

  /// 指定したカテゴリの表示件数が最大（全件表示）に達しているか判定する。
  bool isFullyLoaded(String category, int totalAvailable) {
    if (!managedCategories.contains(category)) return true;
    return getVisibleCount(category) >= totalAvailable;
  }
}
