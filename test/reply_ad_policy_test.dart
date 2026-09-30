import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/reply_ad_policy.dart';
import 'package:news_app/widgets/pr_card.dart';

void main() {
  group('ReplyAdPolicy', () {
    late ReplyAdPolicy policy;

    setUp(() {
      policy = ReplyAdPolicy();
    });

    test('1. 通常広告を追加できる', () {
      policy.addNormalAdAt(9);
      expect(policy.placements[9], AdPlacement.normalComment);
    });

    test('2. 初回のユーザー投稿で広告が追加される', () {
      policy.handlePostContribution(5);
      expect(policy.placements[5], AdPlacement.postContribution);
    });

    test('3. 直前が通常広告なら置換・移動される', () {
      policy.addNormalAdAt(9);
      // ユーザーが10番目（index 10）に投稿した場合、直前（index 9）に広告があれば置換
      policy.handlePostContribution(10);

      expect(policy.placements.containsKey(9), isFalse); // 元の通常広告は削除
      expect(
        policy.placements[10],
        AdPlacement.postContribution,
      ); // ユーザー位置へ移動・置換
    });

    test('4. 10件間隔ルールが適用される', () {
      policy.handlePostContribution(0); // 1つ目追加
      expect(policy.placements[0], AdPlacement.postContribution);

      // index 5 で投稿（間隔5） -> 追加されない
      policy.handlePostContribution(5);
      expect(policy.placements.containsKey(5), isFalse);

      // index 10 で投稿（間隔10） -> 追加される
      policy.handlePostContribution(10);
      expect(policy.placements[10], AdPlacement.postContribution);
    });

    test('5. レス挿入時に後続広告がシフトされる', () {
      policy.addNormalAdAt(10);
      policy.addNormalAdAt(20);

      // index 5 の位置に 3 件挿入
      policy.shiftAdsAfter(5, 3);

      expect(policy.placements[13], AdPlacement.normalComment);
      expect(policy.placements[23], AdPlacement.normalComment);
      expect(policy.placements.length, 2);
    });

    test('6. シフト時に挿入位置より前の広告は維持される', () {
      policy.addNormalAdAt(2);
      policy.shiftAdsAfter(5, 3);
      expect(policy.placements[2], AdPlacement.normalComment);
    });
  });
}
