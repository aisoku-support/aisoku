import 'package:flutter/material.dart';

import 'input_limit_utils.dart';

class NewsDetailReplyInput extends StatefulWidget {
  final TextEditingController controller;
  final VoidCallback onSubmit;
  final VoidCallback onTapOutside;
  final bool isSubmitEnabled;
  final String? disabledMessage;
  final double bottom;

  const NewsDetailReplyInput({
    super.key,
    required this.controller,
    required this.onSubmit,
    required this.onTapOutside,
    required this.isSubmitEnabled,
    this.disabledMessage,
    this.bottom = 0,
  });

  @override
  State<NewsDetailReplyInput> createState() => _NewsDetailReplyInputState();
}

class _NewsDetailReplyInputState extends State<NewsDetailReplyInput> {
  late final FocusNode _focusNode;

  @override
  void initState() {
    super.initState();
    _focusNode = FocusNode();
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: 0,
      right: 0,
      bottom: widget.bottom,
      child: TapRegion(
        groupId: 'reply_box',
        onTapOutside: (_) {
          widget.onTapOutside();
        },
        child: Material(
          elevation: 12,
          color: Theme.of(context).cardColor,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (widget.disabledMessage != null) ...[
                    Text(
                      widget.disabledMessage!,
                      style: const TextStyle(color: Colors.grey, fontSize: 12),
                    ),
                    const SizedBox(height: 8),
                  ],
                  ValueListenableBuilder(
                    valueListenable: widget.controller,
                    builder: (context, value, _) {
                      final count = InputLimitUtils.countCharacters(value.text);
                      final isFull = count >= InputLimitUtils.maxResponseLength;

                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (isFull)
                            const Padding(
                              padding: EdgeInsets.only(bottom: 4),
                              child: Text(
                                '${InputLimitUtils.maxResponseLength}文字まで入力できます',
                                style: TextStyle(
                                  color: Colors.red,
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.end,
                                  children: [
                                    TextField(
                                      controller: widget.controller,
                                      focusNode: _focusNode,
                                      maxLines: 4,
                                      minLines: 1,
                                      autofocus: true,
                                      inputFormatters: [
                                        UserCharacterLimitFormatter(
                                          InputLimitUtils.maxResponseLength,
                                        ),
                                      ],
                                      decoration: InputDecoration(
                                        hintText: 'レスを書き込む',
                                        filled: true,
                                        fillColor: Theme.of(context)
                                            .colorScheme
                                            .surfaceContainer,
                                        border: OutlineInputBorder(
                                          borderRadius: BorderRadius.circular(
                                            12,
                                          ),
                                          borderSide: BorderSide.none,
                                        ),
                                        contentPadding:
                                            const EdgeInsets.symmetric(
                                              horizontal: 14,
                                              vertical: 12,
                                            ),
                                      ),
                                    ),
                                    Padding(
                                      padding: const EdgeInsets.only(
                                        top: 4,
                                        right: 4,
                                      ),
                                      child: Text(
                                        '$count / ${InputLimitUtils.maxResponseLength}',
                                        style: TextStyle(
                                          color: isFull
                                              ? Colors.red
                                              : Colors.grey,
                                          fontSize: 11,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              IconButton.filled(
                                onPressed: widget.isSubmitEnabled
                                    ? widget.onSubmit
                                    : null,
                                icon: const Icon(Icons.send),
                                tooltip: '投稿する',
                              ),
                            ],
                          ),
                        ],
                      );
                    },
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
