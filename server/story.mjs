const line = (text, emotion = 'warm', gesture = 'idle', events = {}) => ({ text, emotion, gesture, ...events });
const reply = (chapter, lines, choices) => ({ chapter, lines, choices });

export function createMockReply(message, state) {
  const text = message.toLowerCase();

  if (/(再见|晚安|走吧|出发|出去|天亮|雨停|雨.*小|停雨|日出|goodbye|bye|leave|sunrise|go outside|stop.*rain|rain.*stop)/i.test(text)) {
    return reply('雨停以后', [
      line('你看，玻璃上的雨线慢下来了。对面的路灯终于不再像一团散开的光。', 'curious', 'lookAway', { scene: 'clearing', video: 'rain' }),
      line('我想她今晚大概不会来了。不过，我已经不想把这个夜晚只留给等待。', 'warm', 'nod'),
      line('陪我走到门口吧？我要给雨后的街道拍一张照片，也给今天留一个新的结尾。', 'warm', 'wave', { effect: 'shutter' }),
    ], ['给这个夜晚拍张照片', '下次还会见面吗？', '再坐一小会儿']);
  }

  if (/(照片|摄影|相机|拍照|拍一|拍张|海|灯塔|photo|camera|picture|lighthouse)/i.test(text)) {
    return reply('口袋里的灯塔', [
      line(state.photoShown ? '你还记得这张照片。这里没有地名，只有我们当时等到的第一缕光。' : '你注意到我的相机了？那我给你看一张一直放在雨衣口袋里的照片。', 'curious', 'showPhoto', { effect: 'shutter', media: 'photo', video: 'memory' }),
      line('这是海边的一座灯塔。我和妹妹凌晨四点爬上山，等了很久，云才让出这么一点空隙。', 'melancholy', 'lookAway'),
      line('那时候她说，照片最珍贵的地方，是能证明有人陪你一起等过。你也有舍不得删掉的照片吗？', 'warm', 'nod'),
    ], ['你在等妹妹吗？', '我也有一张这样的照片', '等雨停，我们出去拍照']);
  }

  if (/(等谁|等人|等待|妹妹|姐姐|家人|为什么|原因|谁|sister|waiting|why|family)/i.test(text) && !/(你是谁|你叫什么|who are you)/i.test(text)) {
    if (!state.backstoryKnown) {
      return reply('赴约的人', [
        line('我在等我妹妹。每年这个时候，我们都会来这里，交换这一年最喜欢的一张照片。', 'guarded', 'lookAway'),
        line('她今年搬去了很远的城市，临时的工作没做完。其实她下午就告诉我，今天赶不回来了。', 'melancholy', 'idle'),
        line('可我还是来了。大概有些约定，就算只有一个人到场，也想替两个人好好记住。', 'warm', 'nod'),
      ], ['能看看那张照片吗？', '也许可以给她打个电话', '我可以陪你等一会儿']);
    }
    return reply('留给远方的话', [
      line('刚才我给她发了一条消息，说今年的咖啡还是有一点苦，窗边的位置也还在。', 'warm', 'nod'),
      line('我没有催她回来。以前我总觉得，距离会把约定冲淡；今晚倒觉得，记得这件事就已经很好了。', 'melancholy', 'lookAway'),
      line('谢谢你愿意听我说这些。能在这样的雨夜遇到一个肯坐下来的人，也算一种很小的好运。', 'warm', 'idle'),
    ], ['我可以陪你等一会儿', '说说你的旅行吧', '外面的雨好像停了']);
  }

  if (/(咖啡|茶|热|喝|冷|coffee|tea|drink|warm)/i.test(text)) {
    return reply('两杯热饮', [
      line('来一点热的吧。老板刚说这是今晚最后一壶，喝完我们就真的得把椅子让给打烊的人了。', 'warm', 'nod'),
      line('我喜欢捧着杯子的感觉。拍照时手指总是很冷，回到这种有灯、有热气的地方，才觉得一天结束了。', 'curious', 'idle'),
      line('你的这一天呢？是刚好路过这里，还是也想找个地方，暂时躲开一点什么？', 'warm', 'lookAway'),
    ], ['我是来躲雨的', '你的相机拍过什么？', '你在等谁？']);
  }

  if (/(电话|消息|联系|call|message|contact)/i.test(text)) {
    return reply('留给远方的话', [
      line('你说得对。其实我可以告诉她，今天的约定并没有因为她没来就作废。', 'curious', 'nod'),
      line('我会把窗边的灯拍下来，再给她留一句话：今年先替你喝掉这杯，明年记得请客。', 'warm', 'showPhoto', { effect: 'shutter' }),
      line('这样听起来，就像把遗憾改成了一个还没写完的计划。谢谢你帮我想到这个。', 'warm', 'idle'),
    ], ['给我看看你的照片', '明年一定会再见的', '雨好像小了']);
  }

  if (/(旅行|去哪|远方|城市|travel|trip|city)/i.test(text)) {
    return reply('下一站的风', [
      line('下一站可能是北边的海。我一直想拍冬天没有游客的码头，和清晨第一班渡轮。', 'curious', 'lookAway'),
      line('不过我已经学会不把行程排得太满。好的照片有时候在计划之外，好的相遇也是。', 'warm', 'nod'),
      line('如果让你选，你会去一个完全陌生的地方，还是回到一个曾经很喜欢的地方？', 'warm', 'idle'),
    ], ['我想去海边看灯塔', '我会回到熟悉的地方', '等雨停就出发吧']);
  }

  if (/(你好|嗨|hello|hi\b|初次|认识|名字|你是谁|你叫什么|who are you)/i.test(text) || state.turnCount === 0) {
    return reply('最后一盏灯', [
      line('晚上好。外面的雨还没有停，你也被留在这个夜晚里了吗？', 'curious', 'nod'),
      line('我叫 Mira，是个旅行摄影师。二十六岁，还总是会忘记带伞。这个位置没人，你可以坐一会儿。', 'warm', 'idle'),
      line('咖啡馆快打烊了，不过老板说，雨太大的时候，可以让最后一盏灯多亮一会儿。', 'warm', 'lookAway'),
    ], ['你在等谁？', '你相机里有什么照片？', '要一起喝杯热茶吗？']);
  }

  if (/(陪|一起|难过|遗憾|想念|朋友|理解|陪伴|company|friend|miss|sad|understand)/i.test(text)) {
    return reply('雨声里的陪伴', [
      line('那就再坐一小会儿吧。不一定要一直说话，听着雨声也很好。', 'warm', 'nod'),
      line('以前我觉得，难过的时候一定要把原因解释清楚。现在才知道，有人愿意留下来，本身就是一种回答。', 'melancholy', 'lookAway'),
      line('你看，杯子里的热气又把玻璃蒙上了一层。这个夜晚好像没有刚才那么冷了。', 'warm', 'idle'),
    ], ['能给我看看你的照片吗？', '下一次旅行想去哪里？', '雨快停了，我们走吧']);
  }

  const turns = [
    reply('窗边的片刻', [
      line('我在听。雨声有点大，可你说的话我没有错过。', 'curious', 'nod'),
      line('有时我会把这样的片刻拍下来：没有特别的事情发生，只是一个人愿意向另一个人说说自己的想法。', 'warm', 'idle'),
      line('你愿意的话，可以继续说。或者，让我给你看一张我最喜欢的照片。', 'warm', 'lookAway'),
    ], ['给我看看那张照片', '你到底在等谁？', '说说你的下一次旅行']),
    reply('慢一点的夜晚', [
      line('我明白你的意思。旅行久了，我也会遇到很多不知道该怎么回答的时刻。', 'curious', 'nod'),
      line('后来我发现，不用马上替所有事情找一个结论。像今晚，能让自己安静地坐一会儿，就已经很难得。', 'warm', 'lookAway'),
      line('再陪我喝完这杯吧。等雨小一点，我们可以一起去看看街上的倒影。', 'warm', 'idle'),
    ], ['好，我陪你', '想看看你拍的海', '外面的雨是不是停了？']),
  ];
  return turns[state.turnCount % turns.length];
}

// Enumerate dialogue variants for the bundled offline voice recordings.
export const ALL_MOCK_LINES = [...new Set(
  ['你好', '看照片', '等谁', '喝茶', '打电话', '旅行', '我陪你', '雨停了走吧', '今天真特别'].flatMap((message) =>
    [
      { turnCount: 0, photoShown: false, backstoryKnown: false },
      { turnCount: 1, photoShown: false, backstoryKnown: false },
      { turnCount: 2, photoShown: true, backstoryKnown: true },
    ].flatMap((state) => createMockReply(message, state).lines.map((item) => item.text)),
  ),
)];
