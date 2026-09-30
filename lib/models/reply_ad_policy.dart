import 'dart:math';

import '../widgets/pr_card.dart';

/// AI掲示板内における広告（PRカード）の配置ポリシーを管理するクラス。
/// 広告の配置インデックス、間隔判定、およびレス挿入時の位置調整ロジックを担う。
class ReplyAdPolicy {
  /// 広告を表示する直前のレスのインデックス（0-based）と配置タイプのマップ
  final Map<int, AdPlacement> _placements = {};
  final Set<int> _enteredViewport = {};

  void markEnteredViewport(int index) => _enteredViewport.add(index);
  bool hasEnteredViewport(int index) => _enteredViewport.contains(index);

  void removeAdAt(int index) {
    _placements.remove(index);
    _enteredViewport.remove(index);
  }

  /// 現在の広告配置状態を取得する
  Map<int, AdPlacement> get placements => Map.unmodifiable(_placements);

  /// 指定したインデックス位置に通常広告（normalComment）を追加する
  void addNormalAdAt(int index) {
    _placements[index] = AdPlacement.normalComment;
  }

  /// ユーザー投稿に伴う広告配置を処理する
  /// 1. 直前が通常広告なら投稿直後広告（postContribution）に置換・移動する
  /// 2. 新規追加の場合は10件間隔ルールを適用する
  void handlePostContribution(int userIndex) {
    // 直前の通常広告でもviewport侵入済みなら保護する。
    final bool isReplacingNormalAd =
        userIndex > 0 &&
        _placements[userIndex - 1] == AdPlacement.normalComment;

    if (isReplacingNormalAd) {
      if (_enteredViewport.contains(userIndex - 1)) return;
      _placements.remove(userIndex - 1);
      _placements[userIndex] = AdPlacement.postContribution;
    } else {
      // 2. 新規追加の場合は10件ルールを適用
      int? lastAdIndex;
      if (_placements.isNotEmpty) {
        lastAdIndex = _placements.keys.reduce(max);
      }

      bool shouldAddPostAd = false;
      if (lastAdIndex == null) {
        shouldAddPostAd = true;
      } else {
        // 直近広告より後ろに存在するReplyItem数を算出
        final int itemsSinceLastAd = userIndex - lastAdIndex;
        if (itemsSinceLastAd >= 10) {
          shouldAddPostAd = true;
        }
      }

      if (shouldAddPostAd) {
        _placements[userIndex] = AdPlacement.postContribution;
      }
    }
  }

  /// レスが挿入された際に、それより後ろにある既存広告のインデックスを一括でずらす
  void shiftAdsAfter(int insertIndex, int count) {
    if (count <= 0) return;

    final Map<int, AdPlacement> shifted = {};
    _placements.forEach((key, value) {
      if (key > insertIndex) {
        shifted[key + count] = value;
      } else {
        shifted[key] = value;
      }
    });

    _placements.clear();
    _placements.addAll(shifted);
    final shiftedEntered = _enteredViewport
        .map((index) => index > insertIndex ? index + count : index)
        .toSet();
    _enteredViewport
      ..clear()
      ..addAll(shiftedEntered);
  }

  /// 指定した位置に広告があるか判定する
  bool hasAdAt(int index) => _placements.containsKey(index);

  /// 広告配置をすべてクリアする（再取得時など）
  void clear() {
    _placements.clear();
    _enteredViewport.clear();
  }
}
