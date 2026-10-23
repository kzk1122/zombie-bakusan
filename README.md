# ゾンビ爆散

迫り来るゾンビの大群を、マシンガンとロケットランチャーで吹き飛ばす15秒1本勝負のブラウザゲームです。舞台は夜の大通り、トゲ付き鉄線フェンスが最終防衛ラインです。

**遊ぶ: https://zombie-bakusan.pages.dev/**

![ゲーム画面](screenshot.jpg)

## 遊び方

- 長押しでマシンガン、タップでロケット。PCは右クリックかスペースキーでもロケットを撃てます
- ドラム缶と車は撃つと大爆発、ビルは撃ち続けると崩れます
- 倒し続けるとFEVER（マシンガン2倍、ロケット撃ち放題）
- 途中で巨大ゾンビがやって来ます。倒して月まで飛ばしましょう
- 負けはありません。15秒で稼いだ点数でランク（S / A / B / C）が決まります

## 中身

- `index.html` 1枚だけで動きます。ビルドも外部ライブラリも不要で、ブラウザで開けばそのまま遊べます
- 描画は Canvas 2D の疑似3D、効果音は Web Audio でその場で合成しています
- 実況とうめき声は [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M)（Apache-2.0）で生成し、ファイルに埋め込んでいます
- フォントは Google Fonts の [Dela Gothic One](https://fonts.google.com/specimen/Dela+Gothic+One) と [Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)（SIL Open Font License）です
