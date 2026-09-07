/** A title promise needs an explicit comparison, not merely two monetary figures. */
export function supportsDouyinPriceComparison(quoteText: string): boolean {
  return quoteText.split(/[。！？!?\n]+/u).some((sentence) => {
    const chargeText = sentence
      .split(/[，,；;]/u)
      .filter((clause) => !/赠|优惠券|代金券|补贴|立减|返现/u.test(clause))
      .join('，');
    return (
      /(?:收费|费用|报价|计费|价格).{0,30}(?:对比|比较)|(?:对比|比较).{0,30}(?:收费|费用|报价|计费|价格)/u.test(
        chargeText,
      ) && (chargeText.match(/\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?\s*元/gu)?.length ?? 0) >= 2
    );
  });
}
