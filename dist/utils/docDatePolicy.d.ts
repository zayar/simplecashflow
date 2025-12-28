/**
 * Document date policy helpers.
 *
 * We compare by *calendar day* in a given time zone (not by timestamp) because
 * accounting documents are generally posted by business day.
 */
export declare function isFutureBusinessDate(args: {
    date: Date;
    now?: Date;
    timeZone?: string | null;
}): boolean;
//# sourceMappingURL=docDatePolicy.d.ts.map