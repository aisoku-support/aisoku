import 'package:flutter/material.dart';

/// 掲示板リストの末尾に表示される、読み込み状態・エラー・再試行ボタンを構築するWidget。
class NewsDetailReplyBottom extends StatelessWidget {
  final bool isGenerating;
  final bool isLoading;
  final String? sharedLoadingMessage;
  final String? loadMoreErrorMessage;
  final VoidCallback onRetry;

  const NewsDetailReplyBottom({
    super.key,
    required this.isGenerating,
    required this.isLoading,
    this.sharedLoadingMessage,
    this.loadMoreErrorMessage,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    if (loadMoreErrorMessage != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              loadMoreErrorMessage!,
              style: const TextStyle(color: Colors.redAccent, fontSize: 13),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('住民を呼び戻す'),
            ),
          ],
        ),
      );
    }

    if (!isGenerating && !isLoading) {
      return const SizedBox.shrink();
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [const SizedBox(height: 12), _buildLoadingIndicator()],
    );
  }

  Widget _buildLoadingIndicator() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          Text(
            sharedLoadingMessage ?? 'AI住人がレスを生成しています...',
            style: const TextStyle(color: Colors.grey, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
