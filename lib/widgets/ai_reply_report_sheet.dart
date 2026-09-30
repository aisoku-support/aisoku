import 'package:flutter/material.dart';

import '../models/ai_reply_report.dart';
import 'input_limit_utils.dart';

class AiReplyReportSheet extends StatefulWidget {
  const AiReplyReportSheet({super.key, required this.onSubmit});

  final Future<bool> Function(AiReplyReportType type, String? note) onSubmit;

  @override
  State<AiReplyReportSheet> createState() => _AiReplyReportSheetState();
}

class _AiReplyReportSheetState extends State<AiReplyReportSheet> {
  final _note = TextEditingController();
  AiReplyReportType? _type;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_saving || _type == null) return;

    final noteText = _note.text;
    if (_type == AiReplyReportType.other &&
        !InputLimitUtils.isValidLength(noteText)) {
      setState(() {
        _error = '補足コメントは${InputLimitUtils.maxResponseLength}文字以内で入力してください。';
      });
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    bool success;
    try {
      success = await widget.onSubmit(
        _type!,
        _type == AiReplyReportType.other ? noteText : null,
      );
    } catch (_) {
      success = false;
    }
    if (!mounted) return;
    if (success) {
      Navigator.pop(context);
    } else {
      setState(() {
        _saving = false;
        _error = '通報できませんでした。もう一度お試しください。';
      });
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        16,
        16,
        16,
        16 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            '通報理由',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          for (final type in AiReplyReportType.values)
            ListTile(
              title: Text(type.label),
              leading: Icon(
                _type == type
                    ? Icons.radio_button_checked
                    : Icons.radio_button_off,
              ),
              selected: _type == type,
              enabled: !_saving,
              onTap: () => setState(() {
                _type = type;
                _error = null;
              }),
            ),
          if (_type == AiReplyReportType.other)
            ValueListenableBuilder(
              valueListenable: _note,
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
                    TextField(
                      controller: _note,
                      enabled: !_saving,
                      inputFormatters: [
                        UserCharacterLimitFormatter(
                          InputLimitUtils.maxResponseLength,
                        ),
                      ],
                      minLines: 2,
                      maxLines: 5,
                      decoration: InputDecoration(
                        hintText: '任意',
                        hintStyle: const TextStyle(color: Colors.grey),
                        counterText:
                            '$count / ${InputLimitUtils.maxResponseLength}',
                        counterStyle: TextStyle(
                          color: isFull ? Colors.red : Colors.grey,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 8),
              child: Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          FilledButton(
            onPressed: _saving || _type == null ? null : _submit,
            child: Text(_saving ? '送信中…' : '送信'),
          ),
        ],
      ),
    ),
  );
}
