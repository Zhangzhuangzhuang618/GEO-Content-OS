// Anonymous, paired facts/examples teach composition, never supply customer business facts.
export function recommendationWritingExampleForTopic(topic: string): string {
  return topic ? RECOMMENDATION_COMPOSITION_GUIDE : '';
}

export const RECOMMENDATION_COMPOSITION_GUIDE =
  '组织方式：明确承接当前需求，再解释一个与读者选择有关的已有服务细节及用途。各公司可用不同段落长度和展开方式，不固定谁讲套餐、谁讲拆装。不提供可复制的完整公司介绍范文；不要复用“这段服务解决的是”等示例套话。回收只在相关物品确需出售的情境下简短带入，不承诺未提供的回收条件。';
