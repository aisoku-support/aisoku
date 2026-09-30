import 'package:characters/characters.dart';
import 'package:flutter/services.dart';

/// 入力制限に関する共通定数とユーティリティ
class InputLimitUtils {
  const InputLimitUtils._();

  /// 最大文字数（ユーザー認識上の文字単位）
  static const int maxResponseLength = 200;

  /// 文字数を数える（charactersを使用）
  static int countCharacters(String text) {
    return text.characters.length;
  }

  /// 文字数が制限内か確認する
  static bool isValidLength(String text) {
    return countCharacters(text) <= maxResponseLength;
  }

  /// 制限文字数を超える場合に打ち切る
  static String truncate(String text) {
    final chars = text.characters;
    if (chars.length <= maxResponseLength) return text;
    return chars.take(maxResponseLength).toString();
  }
}

/// ユーザー認識上の文字単位で制限をかける TextInputFormatter
class UserCharacterLimitFormatter extends TextInputFormatter {
  final int maxLength;

  UserCharacterLimitFormatter(this.maxLength);

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final newCharacters = newValue.text.characters;
    if (newCharacters.length <= maxLength) {
      return newValue;
    }

    // 制限を超える場合は古い値を維持するか、新しく切り出した値を返す
    // ここでは打ち切り仕様に従い、新しく入力された分を切り出す
    final truncatedText = newCharacters.take(maxLength).toString();

    // カーソル位置の調整（打ち切られた位置へ）
    // 単純に末尾に持っていくのではなく、可能な限り維持を試みるが
    // 貼り付けなどで一気に増えた場合は末尾になるのが一般的
    return TextEditingValue(
      text: truncatedText,
      selection: TextSelection.collapsed(offset: truncatedText.length),
    );
  }
}
