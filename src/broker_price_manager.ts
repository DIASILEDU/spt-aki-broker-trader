import { HandbookHelper } from "@spt-aki/helpers/HandbookHelper";
import { ItemHelper } from "@spt-aki/helpers/ItemHelper";
import { RagfairServerHelper } from "@spt-aki/helpers/RagfairServerHelper";
import { IPmcData } from "@spt-aki/models/eft/common/IPmcData";
import { IHandbookBase } from "@spt-aki/models/eft/common/tables/IHandbookBase";
import { ITemplateItem } from "@spt-aki/models/eft/common/tables/ITemplateItem";
import { ITrader } from "@spt-aki/models/eft/common/tables/ITrader";
import { IProcessSellTradeRequestData } from "@spt-aki/models/eft/trade/IProcessSellTradeRequestData";
import { Traders } from "@spt-aki/models/enums/Traders"
import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { DependencyContainer, container as tsyringeContainer } from "tsyringe";
import { Item } from "@spt-aki/models/eft/common/tables/IItem";
import { RagfairPriceService } from "@spt-aki/services/RagfairPriceService";
import { RagfairOfferService } from "@spt-aki/services/RagfairOfferService";

import baseJson from "../db/base.json";
import modInfo from "../package.json";
import modConfig from "../config/config.json";
import { IGlobals, IPriceModifier } from "@spt-aki/models/eft/common/IGlobals";

import * as fs from "fs";
import * as path from "path";
import { PaymentHelper } from "@spt-aki/helpers/PaymentHelper";
import { MemberCategory } from "@spt-aki/models/enums/MemberCategory";
import { Money } from "@spt-aki/models/enums/Money";
import { PresetHelper } from "@spt-aki/helpers/PresetHelper";
import { ItemComponentHelper } from "./item_component_helper";
import { TraderHelper } from "@spt-aki/helpers/TraderHelper";
import { TradersMetaData, BrokerSellData, BrokerPriceManagerCache, TraderMetaData, SellDecision, ProcessedSellData } from "./broker_price_manager_types";
import { ItemComponentTypes, ItemPointsData } from "./item_component_helper_types";
import { ItemBaseClassService } from "@spt-aki/services/ItemBaseClassService";
export class BrokerPriceManager 
{
    private static _instance: BrokerPriceManager;

    private _container: DependencyContainer;

    private handbook: IHandbookBase;
    private handbookHelper: HandbookHelper; // Using with hydrateLookup() might be good to check if items exist in handbook and find their ragfair avg price
    private paymentHelper: PaymentHelper;
    private itemHelper: ItemHelper;
    private baseClassService: ItemBaseClassService;
    private presetHelper: PresetHelper;
    private ragfairServerHelper: RagfairServerHelper;
    private ragfairPriceService: RagfairPriceService;
    private ragfairOfferService: RagfairOfferService;
    private traderHelper: TraderHelper;

    // Broker has several trader ids which separate his operations
    // default valid id is used for selling items to flea
    // the currency ex. id is invalid, used only to group operations with currencies.
    public static brokerTraderId = baseJson._id; // for flea trades
    public static brokerTraderCurrencyExhangeId = `${baseJson._id}-currency-exchange`; // for currency exchange
    private componentHelper: ItemComponentHelper;
    
    private dbServer: DatabaseServer;
    private dbGlobals: IGlobals;
    private dbItems: Record<string, ITemplateItem>; // Might replace with ItemHelper.getItems() since I don't write anything into the database
    private dbTraders: Record<string, ITrader>;
    public supportedTraders: string[] = [];

    private _tradersMetaData: TradersMetaData;
    private _currencyBasePrices: Record<string, number>; // currency base prices based on PK and Skier prices
    private _itemRagfairPriceTable: Record<string, number>; // used as a cache, contains itemTplId => avg price, price per point(of durability/resource), tax, tax per point

    private _clientBrokerSellData: Record<string, BrokerSellData> = {};

    private constructor(container?: DependencyContainer)
    {
        this._container = container ?? tsyringeContainer;

        this.componentHelper = new ItemComponentHelper(this._container);
        this.itemHelper = container.resolve<ItemHelper>(ItemHelper.name);
        this.baseClassService = container.resolve<ItemBaseClassService>(ItemBaseClassService.name);
        this.presetHelper = container.resolve<PresetHelper>(PresetHelper.name)
        this.handbookHelper = container.resolve<HandbookHelper>(HandbookHelper.name);
        this.paymentHelper = container.resolve<PaymentHelper>(PaymentHelper.name);
        this.ragfairServerHelper = container.resolve<RagfairServerHelper>(RagfairServerHelper.name);
        this.ragfairPriceService = container.resolve<RagfairPriceService>(RagfairPriceService.name);
        this.ragfairOfferService = container.resolve<RagfairOfferService>(RagfairOfferService.name);
        this.traderHelper = container.resolve<TraderHelper>(TraderHelper.name);

        this.dbServer = container.resolve<DatabaseServer>(DatabaseServer.name);
        this.dbGlobals = this.dbServer.getTables().globals;
        this.handbook = this.dbServer.getTables().templates.handbook;
        this.dbItems = this.dbServer.getTables().templates.items;
        this.dbTraders = this.dbServer.getTables().traders;

        this._currencyBasePrices = {};
    }
    
    /**
     * Initializes the array of supported trader ids. 
     * Move to a separate method to make it delayed.
     * Should be executed inside initializeLookUpTables(PostAkiLoad), after all custom traders have been loaded into the database.
     */
    public initializeSupportedTraders(): void
    {
        // Init supported traders list with default traders, except lighthouse keeper
        //const defaultTraderIds: string[] = Object.values(Traders).filter((id: string) => id !== Traders.LIGHTHOUSEKEEPER);
        const defaultTraderIds: string[] = [
            Traders.PRAPOR,
            Traders.THERAPIST,
            Traders.FENCE,
            Traders.SKIER,
            Traders.PEACEKEEPER,
            Traders.MECHANIC,
            Traders.RAGMAN,
            Traders.JAEGER
            // No need to filter out Lighthouse Keeper here
        ];
    
        this.supportedTraders = defaultTraderIds;
        // Pull up custom traders
        if (modConfig.useCustomTraders)
        {
            // If no explicit id's specified just use any available trader from database (except LK).
            if (modConfig.customTraderIds == null || modConfig.customTraderIds.length < 1)
            {
                // Exclude LK and "ragfair"
                this.supportedTraders = Object.keys(this.dbTraders).filter(
                    (id: string) => 
                        ![Traders.LIGHTHOUSEKEEPER, "ragfair", BrokerPriceManager.brokerTraderId, BrokerPriceManager.brokerTraderCurrencyExhangeId].includes(id)
                );
                console.log("No custom trader id's specified. Using all available traders.")
            }
            else 
            {
                // Filter out accidental trader id's to avoid duplicates
                this.supportedTraders = this.supportedTraders.concat(modConfig.customTraderIds.filter(
                    id => !defaultTraderIds.concat([BrokerPriceManager.brokerTraderId, BrokerPriceManager.brokerTraderCurrencyExhangeId]).includes(id))
                );
            }
        }
        console.log(`[${modInfo.name} ${modInfo.version}] Initialized supported traders range. ${this.supportedTraders.length} traders are being supported.`);
    }

    /**
     * Assigns "SellDecision" data received from the client. Client provided data allows for accurate prices and taxes.
     * @param data Received "SellDecision" data.
     */
    public setClientBrokerPriceData(data: Record<string, BrokerSellData>): void
    {
        this._clientBrokerSellData = data;
    }

    /**
     * Should be used in postAkiLoad() and after the instance is initialized.
     * Generates look-up tables.
     * Uses cache to speed up server load time on next start ups.
     */
    public initializeLookUpTables(): void
    {        
        // Init array of supported traders id.
        this.initializeSupportedTraders();
        // BrokerPriceManager.getInstance(); - can be used as a temporary bandaid but...
        // This method should fail if class hasn't been yet instantialized.
        const cacheDir = path.normalize(path.resolve(`${__dirname}/../cache`));
        const cacheFullPath = path.normalize(path.resolve(`${__dirname}/../cache/cache.json`));
        
        if (fs.existsSync(cacheFullPath) && modConfig.useCache)
        {
            this.tryToLoadCache(cacheFullPath);
        }
        else 
        {
            this.generateLookUpTables();
            if (modConfig.useCache)
                this.tryToSaveCache(cacheDir, cacheFullPath);         
        }
        
        this._tradersMetaData = this.getTradersMetaData(); // no need to cache, it's trivial and new traders might require it to be up-to-date. 
        console.log(`[${modInfo.name} ${modInfo.version}] Loaded trader meta data from database.`);
        this.initializeCurrencyBuyRates(); // no need to cache since it's trivial
        console.log(`[${modInfo.name} ${modInfo.version}] Loaded currency buy rates from config.`);
        
        
    } 

    private generateLookUpTables(): void
    {
        console.log(`[${modInfo.name} ${modInfo.version}] Generating ragfair price look-up table...`);
        this._itemRagfairPriceTable = this.getItemRagfairPriceTable();
        console.log(`[${modInfo.name} ${modInfo.version}] Look-up table successfully generated.`);
    }

    private tryToSaveCache(absCacheDir: string, absCacheFullPath: string): void
    {
        console.log(`[${modInfo.name} ${modInfo.version}] Saving ragfair price look-up table to cache...`);
        try 
        {
            const bpmCache: BrokerPriceManagerCache = {
                itemRagfairPriceTable: this._itemRagfairPriceTable
            }
            fs.mkdirSync(absCacheDir);
            fs.writeFileSync(absCacheFullPath, JSON.stringify(bpmCache), {flag: "w"});
        }
        catch (error) 
        {
            console.log(`[${modInfo.name} ${modInfo.version}] Error. Couldn't save to cache.`);
        }
        console.log(`[${modInfo.name} ${modInfo.version}] Look-up table successfully cached.`);
    }

    private tryToLoadCache(absCacheFullPath: string): void
    {
        console.log(`[${modInfo.name} ${modInfo.version}] Loading ragfair price look-up table from cache...`);
        try 
        {
            const bpmCache = JSON.parse(fs.readFileSync(absCacheFullPath, {flag: "r"}).toString()) as BrokerPriceManagerCache;
            this._itemRagfairPriceTable = bpmCache.itemRagfairPriceTable;
        }
        catch (error) 
        {
            console.log(`[${modInfo.name} ${modInfo.version}] Error. Couldn't load look-up tables from cache. Please remove cache file if it exists, to resave the cache next time you launch the server.`);
            this.generateLookUpTables();
        }
        console.log(`[${modInfo.name} ${modInfo.version}] Look-up table successfully loaded from cache.`);
    }

    private initializeCurrencyBuyRates()
    {
        // Get USD and EUR prices from PK and Skier assorts
        const pkAssort = this.traderHelper.getTraderAssortsByTraderId(Traders.PEACEKEEPER);
        const pkUsdItemId = pkAssort.items.find(item => item._tpl === Money.DOLLARS)._id;
        const pkDollarPrice = pkAssort.barter_scheme[pkUsdItemId][0][0].count;

        const skiAssort = this.traderHelper.getTraderAssortsByTraderId(Traders.SKIER);
        const skiEurItemId = skiAssort.items.find(item => item._tpl === Money.EUROS)._id;
        const skiEuroPrice = skiAssort.barter_scheme[skiEurItemId][0][0].count;

        this._currencyBasePrices[Money.DOLLARS] = pkDollarPrice;
        this._currencyBasePrices[Money.EUROS] = skiEuroPrice;
    }

    public static getInstance(container?: DependencyContainer): BrokerPriceManager
    {
        if (!this._instance)
        {
            BrokerPriceManager._instance = new BrokerPriceManager(container);
        }
        return this._instance;
    }

    /**
     * Check if provided id is a trader id which designates Broker flea sales.
     * @param traderId Trader id to check.
     * @returns true | false - whether it's a "sell to flea" Broker id.
     */
    public static isFleaMarket(traderId: string): boolean
    {
        return BrokerPriceManager.brokerTraderId === traderId;
    }

    /**
     * Checks whether the provided trader id is one of Broker's ids, since Broker has two trader ids(one for flea sales, other for currency ex. feature).
     * @param traderId Trader id to check.
     * @returns true | false - whether the id is one of Broker's ids.
     */
    public static isBroker(traderId: string): boolean
    {
        return [BrokerPriceManager.brokerTraderId, BrokerPriceManager.brokerTraderCurrencyExhangeId].includes(traderId);
    }

    public get container(): DependencyContainer
    {
        return this._container;
    }

    public static get instance(): BrokerPriceManager
    {
        return this.getInstance();
    }

    public get currencyBasePrices(): Record<string, number>
    {
        return this._currencyBasePrices
    }

    public get tradersMetaData(): TradersMetaData
    {
        return this._tradersMetaData;
    }

    public get itemRagfairPriceTable(): Record<string, number>
    {
        return this._itemRagfairPriceTable;
    }

    /**
     * Collectst average ragfair price for each item template. Used as a base price when calculating item ragfair sell price(Broker sell to flea feature).
     * @returns Record, key - item template id, value - average ragfair price, based on existing offers.
     */
    public getItemRagfairPriceTable(): Record<string, number>
    {
        const validRagfairItemTplIds = Object.values(this.dbItems).filter(itemTpl => this.ragfairServerHelper.isItemValidRagfairItem([true, itemTpl])).map(itemTpl => itemTpl._id);
        return validRagfairItemTplIds.reduce((accum, itemTplId) => 
        {
            accum[itemTplId] = this.getItemTemplateRagfairPrice(itemTplId);
            return accum;
        }, {});
    }

    /**
     * Collect and return traders meta data from database.
     * Includes 2 "traders" to designate Broker flea sales and currency exchange
     * @returns TradersMetaData. Key is trader Id, value - TraderMetaData
     */
    private getTradersMetaData(): TradersMetaData
    {
        const data: TradersMetaData = {};
        const defaultTraderIds: string[] = Object.values(Traders);
        for (const traderId of this.supportedTraders)
        {
            const traderName = this.dbTraders[traderId].base.nickname;
            const currency = this.dbTraders[traderId].base.currency;
            const traderCoef = this.dbTraders[traderId].base.loyaltyLevels[0].buy_price_coef;
            const itemsBuy = this.dbTraders[traderId].base.items_buy;
            const itemsBuyProhibited = this.dbTraders[traderId].base.items_buy_prohibited;
            data[traderId] = {
                id: traderId,
                name: traderName,
                currency: currency,
                itemsBuy: itemsBuy,
                itemsBuyProhibited: itemsBuyProhibited,
                buyPriceCoef: traderCoef
            };
            if (!defaultTraderIds.includes(traderId)) console.log(`[${modInfo.name} ${modInfo.version}] Loaded meta data for custom trader: ${traderName}`);
        }

        // Manually add Broker's Meta Data
        // Only used as a sort of "sell to flea" or "currency exchange" flag
        data[BrokerPriceManager.brokerTraderId] = {
            id: BrokerPriceManager.brokerTraderId,
            name: `${baseJson.nickname.toUpperCase()}(Flea Market)`,
            currency: "RUB",
            itemsBuy: {category: [], id_list: []},
            itemsBuyProhibited: {category: [], id_list: []},
            buyPriceCoef: Infinity // to make sure it's never selected as the most profitable trader
        }; 
        data[BrokerPriceManager.brokerTraderCurrencyExhangeId] ={
            id: BrokerPriceManager.brokerTraderCurrencyExhangeId,
            name: `${baseJson.nickname.toUpperCase()}(Currency Ex.)`,
            currency: "RUB",
            itemsBuy: {category: [], id_list: []},
            itemsBuyProhibited: {category: [], id_list: []},
            buyPriceCoef: Infinity // to make sure it's never selected as the most profitable trader
        };
        return data;
    }

    /**
     * Check if an item can be sold to a trader.
     * Makes sure that both conditions are met: trader buys item template and item condition passes restrictions.
     * If trader is Fence - restrictions are not accounted.
     * @param pmcData PMC to whom item belongs.
     * @param item Item to check.
     * @param traderId Id of the trader to check.
     * @returns true | false
     */
    public canBeSoldToTrader(pmcData: IPmcData, item: Item, traderId: string): boolean
    {
        const itemAndChildren = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, item._id);
        return !itemAndChildren.some(item => !this.canTemplateBeSoldToTrader(item._tpl, traderId) || !this.passesBuyoutRestrictions(item, traderId === Traders.FENCE))
            && (modConfig.tradersIgnoreUnlockedStatus || (pmcData?.TradersInfo[traderId]?.unlocked ?? false)); // default being false seems logical, but might change to true if needed
    }

    /**
     * Check if item template can be sold to trader.
     * @param itemTplId Item Template Id
     * @param traderId Trader Id
     * @returns true | false
     */
    public canTemplateBeSoldToTrader(itemTplId: string, traderId: string ): boolean
    {
        const traderMetaData = this.tradersMetaData[traderId];
        const buysItem = traderMetaData.itemsBuy.category.some(categoryId => this.itemHelper.isOfBaseclass(itemTplId, categoryId)) || traderMetaData.itemsBuy.id_list.includes(itemTplId);
        const notProhibited = !traderMetaData.itemsBuyProhibited.category.some(categoryId => this.itemHelper.isOfBaseclass(itemTplId, categoryId)) && !traderMetaData.itemsBuyProhibited.id_list.includes(itemTplId);
        return buysItem && notProhibited;
    }

    /**
     * Get the most profitable trader for an item.
     * @param pmcData PMC to whom item belongs.
     * @param item Item
     * @returns TraderMetaData
     */
    public getBestTraderForItem(pmcData: IPmcData, item: Item): TraderMetaData
    {
        // explicit assignment of Broker when selling money for currency exchange, seems needless to go through everything.
        if (this.paymentHelper.isMoneyTpl(item._tpl)) return this.tradersMetaData[BrokerPriceManager.brokerTraderCurrencyExhangeId];

        const sellableTraders = Object.values(this.tradersMetaData).filter(traderMeta => this.canBeSoldToTrader(pmcData, item, traderMeta.id));
        if (sellableTraders.length < 1) return null; // If no traders can buy this item return NULL
        // the lower the coef the more money you'll get
        const lowestCoef = Math.min(...sellableTraders.map(trader => trader.buyPriceCoef));
        return sellableTraders.find(trader => trader.buyPriceCoef === lowestCoef);
    }

    /**
     * Main method which processes each item and provides a decision.
     * Get the most profitable sell decision for an item. 
     * Selects between selling to most profitable trader or ragfair.
     * @param pmcData PMC to whom item belongs.
     * @param item Item 
     * @returns SellDecision
     */
    public getBestSellDecisionForItem(pmcData: IPmcData, item: Item): SellDecision
    {
        // Client data is very important for accuracy 
        if (this._clientBrokerSellData[item._id] != undefined && modConfig.useClientPlugin)
        {
            //console.log(`[BROKER] RECEIVED SELL DATA FROM CLIENT FOR ${item._id}`);
            const clientSellData = this._clientBrokerSellData[item._id];
            const itemIsMoney = this.paymentHelper.isMoneyTpl(item._tpl);
            const isBroker = BrokerPriceManager.isFleaMarket(clientSellData.TraderId)
            return {
                // Separate currency exchanges from flea trades.
                traderId: isBroker && itemIsMoney ? BrokerPriceManager.brokerTraderCurrencyExhangeId : clientSellData.TraderId,
                price: clientSellData.Price,
                priceInRoubles: clientSellData.PriceInRoubles,
                commission: clientSellData.Commission,
                commissionInRoubles: clientSellData.CommissionInRoubles,
                tax: clientSellData.Tax
            };
        }
        if (modConfig["useClientPlugin"] ?? true) // sort of a hidden option to disable warnings when you use the mod without the client plugin.
            console.log(`[${modInfo.name} ${modInfo.version}] Couldn't find Client Sell Data for item id ${item._id}. Processing by server. If this happens very often, inform the developer.`);
        const bestTrader = this.getBestTraderForItem(pmcData, item);
        const traderPrice = this.getItemTraderPrice(pmcData, item, bestTrader.id);
        // ragfairIgnoreAttachments - Check if we ignore each child ragfair price when calculating ragfairPrice.
        // When accounting child items - total flea price of found in raid weapons can be very unbalanced due to how in SPT-AKI
        // some random, even default weapon attachments have unreasonable price on flea.
        const ragfairPrice = modConfig.ragfairIgnoreAttachments ? this.getSingleItemRagfairPrice(item) : this.getItemRagfairPrice(item, pmcData);  
        // console.log(`[traderPrice] ${traderPrice}`);      
        // console.log(`[ragfairPrice] ${ragfairPrice}`);      
        // console.log(`[TAX] ${this.ragfairTaxHelper.calculateTax(item, pmcData, ragfairPrice, this.getItemStackObjectsCount(item), true)}`);
        // console.log("PARAMS:",item, pmcData, ragfairPrice, this.getItemStackObjectsCount(item), true);

        // Tarkov price logic is simple - Math.Floor profits, Math.Ceil losses, Round Taxes.
        if (modConfig.useRagfair && ragfairPrice >= traderPrice && this.canSellOnFlea(item) && this.playerCanUseFlea(pmcData))
        {
            return {
                traderId: BrokerPriceManager.brokerTraderId,
                price: Math.ceil(ragfairPrice),
                priceInRoubles: Math.ceil(ragfairPrice),
                commission: Math.round(ragfairPrice * modConfig.profitCommissionPercentage / 100),
                commissionInRoubles: Math.round(ragfairPrice * modConfig.profitCommissionPercentage / 100), // for ragfair there is no conversion
                tax: Math.round(this.getItemRagfairTax(item, pmcData, ragfairPrice, this.getItemStackObjectsCount(item), true) ?? 0)
            };
        }
        const itemIsMoney = this.paymentHelper.isMoneyTpl(item._tpl); // if it's a currency exchange - no commission.
        return {
            traderId: bestTrader.id,
            // perhaps "isMoney" check should be moved elsewhere, can't be bothered right now.
            price: itemIsMoney ? Math.round(traderPrice) : Math.floor(this.convertRoublesToTraderCurrency(traderPrice, bestTrader.id)),
            priceInRoubles: itemIsMoney ? Math.round(traderPrice) : Math.floor(traderPrice),
            commission: itemIsMoney ? 0 : Math.round(Math.floor(this.convertRoublesToTraderCurrency(traderPrice, bestTrader.id)) * modConfig.profitCommissionPercentage / 100),
            commissionInRoubles: itemIsMoney ? 0 : Math.round(Math.floor(traderPrice) * modConfig.profitCommissionPercentage / 100)
        };
    }

    /**
     * Calculates the flea tax while taking in account user's Intelligence Center bonus and Hideout Management skill.
     * 
     * Had to make it myself since the RagfairTaxHelper.calculateTax seems not accurate and sometimes returned NULL.
     * @param item Item to evaluate the tax.
     * @param pmcData PMC profile to whom the item belongs.
     * @param requirementsPrice The price you want to sell the item for.
     * @param offerItemCount How many items in the flea offer.
     * @param sellInOnePiece Sell in batch or not.
     * @returns Flea tax value.
     */
    // Reference "GClass1969.CalculateTaxPrice()"
    public getItemRagfairTax(item: Item, pmcData: IPmcData, requirementsPrice: number, offerItemCount: number, sellInOnePiece: boolean): number
    {
        if (requirementsPrice < 1 || offerItemCount < 1) return 0;

        const num = this.getBaseTaxForAllItems(pmcData, item, offerItemCount);
        requirementsPrice *= sellInOnePiece ? 1 : offerItemCount;
        const ragfairConfig = this.dbGlobals.config.RagFair;
        const num2 = ragfairConfig.communityItemTax / 100;
        const num3 = ragfairConfig.communityRequirementTax / 100;
        let num4 = Math.log10(num / requirementsPrice);
        let num5 = Math.log10(requirementsPrice / num);
        if (requirementsPrice >= num)
            num5 = Math.pow(num5, 1.08);
        else
            num4 = Math.pow(num4, 1.08);
        num5 = Math.pow(4.0, num5);
        num4 = Math.pow(4.0, num4);

        let num6 = num * num2 * num4 + requirementsPrice * num3 * num5;

        // Accounts for only one flea tax reduction bonus, since no other hideout are provides such bonuses.
        const intelBonus = pmcData.Bonuses.find(bonus => bonus.type === "RagfairCommission");
        // It might be undefined when you have no intel center built at all.
        // if (hideoutManagement == undefined) console.log("[Broker Trader] COULDN'T FIND INTELLIGENCE CENTER , DEFAULTING TO NO TAX REDUCTION");
        const intelBonusVal = Math.abs(intelBonus?.value ?? 0); // expect that bonus.value will be NEGATIVE
        const hideoutManagement = pmcData.Skills.Common.find(skill => skill.Id === "HideoutManagement");
        if (hideoutManagement == undefined) console.log("[Broker Trader] COULDN'T FIND HIDEOUT MANAGEMENT SKILL, DEFAULTING TO SKILL LEVEL 1");
        const hmProgress = hideoutManagement?.Progress ?? 1; // total skill xp
        // Wiki states that hideout management hives 0.3% per level. But config says 1%. Ingame says 1%. Prefer config value.
        const hmSkillBoostPercent = this.dbGlobals.config.SkillsSettings.HideoutManagement.SkillBoostPercent; // precent per 1 level
        // Important! When calculating hideout management level (hmprogress/100) truncate floating digits.
        const hmAreaMultiplier = 1 + Math.trunc(hmProgress / 100) * hmSkillBoostPercent / 100; // how much the intel tax reduction should be buffed
        const intelTaxModifier = 1 - intelBonusVal * hmAreaMultiplier / 100; // total intel center reduction with hideout management accounted for

        // console.log(`[INTEL BONUS VAL] ${intelBonusVal}`)
        // console.log(`[H M MODIFIER] ${hmAreaMultiplier}`)
        // console.log(`[INTEL TAX MODIFIER] ${intelTaxModifier}`)

        num6 *= intelTaxModifier;

        const itemTpl = this.dbItems[item._tpl];
        if (item == undefined) throw (`BrokerPriceManager | Couldn't find item with template ${item._tpl} when calculating flea tax!`);
        num6 *= itemTpl._props.RagFairCommissionModifier;

        if (this.componentHelper.hasComponent(item, ItemComponentTypes.BUFF))
        {
            // "Points" is "Buff.value"
            const buffComponent = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.BUFF);
            const buffType = item.upd.Buff.buffType;
            const priceModifier = (this.dbGlobals.config.RepairSettings.ItemEnhancementSettings[buffType] as IPriceModifier).PriceModifier;
            num6 *= 1 + Math.abs(buffComponent.points - 1) * priceModifier;
        }

        return Math.ceil(num6);
    }

    public getBaseTaxForAllItems(pmcData: IPmcData, item: Item, itemCount: number, basePriceSrc?: Record<string, number>): number
    {
        const itemAndChildren = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, item._id);
        // pass isFence explicitly true, to skip "passesRestrictions"
        return itemAndChildren.reduce((accum, curr) => accum + this.getBuyoutPriceForSingleItem(curr, (curr._id === item._id) ? itemCount : 0, true, basePriceSrc), 0);
    }

    /**
     * Check if item can be sold on flea market.
     * 
     * Uses "ragfairServerHelper.isItemValidRagfairItem". If "ragfairIgnoreFoundInRaid" config value is set to true - true will always be passed into "spawnedInSession" parameter.
     * @param item Item to check.
     * @returns true | false - can the item be sold on flea?
     */
    public canSellOnFlea(item: Item): boolean
    {
        // const itemTpl = this.itemHelper.getItem(item._tpl)[1]; - keep it here if I move to itemHelper later
        const itemTpl = this.dbItems[item._tpl];
        const foundInRaid = modConfig.ragfairIgnoreFoundInRaid || (item.upd?.SpawnedInSession ?? false);
        // console.log(item.upd?.SpawnedInSession ?? false);

        // The first boolean param seems to refer to "spawnedInSession"(found in raid)
        return this.ragfairServerHelper.isItemValidRagfairItem([foundInRaid, itemTpl]);
    }

    /**
     * Checks if user level fits the flea requirement. If "ragfairIgnorePlayerLevel" config value is true - always returns true.
     * @param pmcData PMC profile data
     * @returns true | false. Does user have the level to use flea?
     */
    public playerCanUseFlea(pmcData: IPmcData): boolean
    {
        return modConfig.ragfairIgnorePlayerLevel || (pmcData.Info.Level >= this.dbServer.getTables().globals.config.RagFair.minUserLevel);
    }

    /**
     * Process a sell request body and return a result of multiple sell requests grouped per trader id.
     * In the mod used to assign items to corresponding most profitable traders(including Broker flea and currency ex.)
     * @param pmcData PMC who sells.
     * @param sellData Body of a sell request.
     * @returns Processed sell request data.
     */
    public processSellRequestDataForMostProfit(pmcData: IPmcData, sellData: IProcessSellTradeRequestData): ProcessedSellData
    {
        const sellDataItems = sellData.items;
        return sellDataItems.reduce((accum, currItem) => 
        {
            const inventoryItem = this.getItemFromInventoryById(currItem.id, pmcData);
            const sellDecision = this.getBestSellDecisionForItem(pmcData, inventoryItem);
            const groupByTraderId = sellDecision.traderId;
            const itemPrice = sellDecision.price; 
            const itemTax = (sellDecision.tax ?? 0);
            const commission = sellDecision.commission;
            const commissionInRoubles = sellDecision.commissionInRoubles;
            const profit = itemPrice - itemTax - commission;
            const profitInRoubles = sellDecision.priceInRoubles - itemTax - commissionInRoubles;
            const itemStackObjectsCount = this.getItemStackObjectsCount(inventoryItem);
            // No need to stress the server and count every child when we ignore item children, due to how getFullItemCont works.
            const fullItemCount = modConfig.ragfairIgnoreAttachments ? itemStackObjectsCount : this.getFullItemCount(inventoryItem, pmcData);
            if (accum[groupByTraderId] == undefined)
            {
                // Create new group
                accum[groupByTraderId] = {
                    isFleaMarket: BrokerPriceManager.isFleaMarket(groupByTraderId),
                    traderName: this.tradersMetaData[groupByTraderId].name,
                    totalPrice: itemPrice,
                    totalTax: itemTax,
                    totalProfit: profit,
                    totalProfitInRoubles: profitInRoubles,
                    commission: commission,
                    commissionInRoubles: commissionInRoubles,
                    totalItemCount: 1,
                    totalStackObjectsCount: itemStackObjectsCount,
                    fullItemCount: fullItemCount,
                    requestBody: {
                        Action: sellData.Action,
                        items: [currItem],
                        price: profit,
                        tid: BrokerPriceManager.isBroker(groupByTraderId) ? BrokerPriceManager.brokerTraderId : groupByTraderId,
                        type: sellData.type
                    }
                };
            }
            else 
            {
                // Updating existing group
                accum[groupByTraderId].totalPrice += itemPrice;
                accum[groupByTraderId].totalTax += itemTax;
                accum[groupByTraderId].totalProfit += profit;
                accum[groupByTraderId].totalProfitInRoubles += profitInRoubles;
                accum[groupByTraderId].commission += commission;
                accum[groupByTraderId].commissionInRoubles += commissionInRoubles;
                accum[groupByTraderId].totalItemCount += 1;
                accum[groupByTraderId].totalStackObjectsCount += itemStackObjectsCount;
                accum[groupByTraderId].fullItemCount += fullItemCount;

                accum[groupByTraderId].requestBody.items.push(currItem);
                accum[groupByTraderId].requestBody.price += profit;
            }
            return accum;
        }, {} as ProcessedSellData);
    }

    /**
     * Calculates the item price for a PMC, when selling to a specified trader.
     * @param pmcData PMC to whom item belongs.
     * @param item Target item.
     * @param traderId Target trader id.
     * @returns number - trader price of an item
     */
    // Reference - "TraderClass.GetUserItemPrice"
    public getItemTraderPrice(pmcData: IPmcData, item: Item, traderId: string): number
    {
        // explicit currency pricing, price is rounded on getBestSellDecision.
        if (this.paymentHelper.isMoneyTpl(item._tpl)) return this._currencyBasePrices[item._tpl] * this.getBrokerBuyRates()[item._tpl] * this.getItemStackObjectsCount(item);

        if (!this.canBeSoldToTrader(pmcData, item, traderId)) return 0;

        const traderMeta = this.tradersMetaData[traderId];
        if (traderMeta == undefined) throw (`BrokerPriceManager | getTraderItemPrice, couldn't find trader meta by id ${traderId}`);

        let price = this.getBuyoutPriceForAllItems(pmcData, item, 0, traderId === Traders.FENCE);
        price = price * (1 - traderMeta.buyPriceCoef/100); // apply trader price modifier
        return price;
    }

    /**
     * Collects and returns configured "buyRate" property values in a dictionary(record).
     * @returns Record, key - currency template id, value - buy rate from mod config.
     */
    public getBrokerBuyRates(): Record<string, number>
    {
        const rates = {};
        rates[Money.DOLLARS] = modConfig.buyRateDollar;
        rates[Money.EUROS] = modConfig.buyRateEuro;
        return rates;
    }

    /**
     * Calculates buyout price for item and it's children. (Sort of an item's worth.)
     * @param pmcData PMC to whom the item belongs.
     * @param item Item
     * @param itemCount Item Count. If passed 0 - uses item StackObjectsCount.
     * @param isFence Are you calculating for Fence? (Do you wan't to ignore buyout(min durability/resource) restrictions.)
     * @param basePriceSrc Source for the base price. By default and pretty much everywhere in client's source code - handbook price.
     * @returns number
     */
    // Refernce - "GClass1969.CalculateBasePriceForAllItems"
    public getBuyoutPriceForAllItems(pmcData: IPmcData, item: Item, itemCount: number, isFence: boolean, basePriceSrc?: Record<string, number>): number
    {
        let price = 0;
        
        // Here should be check if item is a container with items
        // but no need for it, since it's checked clientside.

        const itemAndChildren = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, item._id);
        //console.log(`[BUYOUT] BASE ITEM IS AMONG CHILDREN ARRAY ${itemAndChildren.find(itc => itc._id === item._id) != undefined}`)
        for (const itemIter of itemAndChildren)
        {
            const priceIter = this.getBuyoutPriceForSingleItem(itemIter, (itemIter._id === item._id) ? itemCount : 0, isFence, basePriceSrc);
            if (priceIter === 0) return 0;
            price += priceIter;
        }
        return price;
    }

    /**
     * Calculates a buyout price for single item. Buyout price can be considered as a pure item value, which is calculated
     * from item's base price(handbook) influenced by item's component conditions(Repairable? - durability, etc., Buff? - buff value, Resource/Medkit - currenct resource value, etc.).
     * @param item Target item.
     * @param itemCount Number of items (usually StackObjectsCount).
     * @param isFence Is the target trader Fence? Decides whether method should ignore buyout restrictions (Min durability, resource etc.)
     * @param basePriceSrc Optional. Source for base prices, by default - hanbdook.
     * @returns number - buyout price
     */
    // Reference - "GClass1969.CalculateBuyoutBasePriceForSingleItem()" and "GClass1969.smethod_0()"
    public getBuyoutPriceForSingleItem(item: Item, itemCount: number, isFence: boolean, basePriceSrc?: Record<string, number>): number
    {
        if (!this.passesBuyoutRestrictions(item, isFence)) return 0;

        if (itemCount < 1) itemCount = this.getItemStackObjectsCount(item);

        let price: number;

        if (basePriceSrc != null) price = basePriceSrc[item._tpl];
        else price = this.handbookHelper.getTemplatePrice(item._tpl);

        if (price == null) throw ("BrokerPriceManager | getBuyoutPriceForSingleItem \"price\" is undefined, something is wrong with handbook or basePriceSrc param!");

        let component: ItemPointsData;
        const props = this.dbItems[item._tpl]?._props;
        if (props == null) throw ("BrokerPriceManager | getBuyoutPriceForSingleItem \"props\" is undefined, couldn't find item template in database!");

        if (this.componentHelper.hasComponent(item, ItemComponentTypes.REPAIRABLE))
        {
            // "Points" are Durability
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.REPAIRABLE);
            const num2 = 0.01 * Math.pow(0, component.maxPoints);
            const num3 = Math.ceil(component.maxPoints);
            const num4 = props.RepairCost * (num3 - Math.ceil(component.points));
            price = price * (num3 / component.templateMaxPoints + num2) - num4;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.BUFF))
        {
            // "Points" is Buff.value
            const buffType = item.upd.Buff.buffType;
            const priceModifier = (this.dbGlobals.config.RepairSettings.ItemEnhancementSettings[buffType] as IPriceModifier).PriceModifier;
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.BUFF);
            price *= 1 + Math.abs(component.points - 1) * priceModifier;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.DOGTAG))
        {
            // "Points" is Dogtag.Level
            price *= this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.DOGTAG).points;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.KEY))
        {
            // "Points" is NumberOfUsages
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.KEY);
            // Important! Use Math.max to avoid dividing by 0, when point, maxpoints, templatemaxpoints in component equal 1.
            price = price / Math.max(component.templateMaxPoints * (component.templateMaxPoints - component.points), 1);
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.RESOURCE))
        {
            // "Points" is Value, "MaxPoints" is MaxResource
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.RESOURCE);
            price = price * 0.1 + price * 0.9 / component.maxPoints * component.points;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.SIDE_EFFECT))
        {
            // "Points" is Value, "MaxPoints" is MaxResource
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.SIDE_EFFECT);
            price = price * 0.1 + price * 0.9 / component.maxPoints * component.points;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.MEDKIT))
        {
            // "Points" is HpResource, "MaxPoints" is MaxResource
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.MEDKIT);
            price = price / component.maxPoints * component.points;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.FOOD_DRINK))
        {
            // "Points" is HpPercent, "MaxPoints" is MaxResource
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.FOOD_DRINK);
            price = price / component.maxPoints * component.points;
        }
        if (this.componentHelper.hasComponent(item, ItemComponentTypes.REPAIRKIT))
        {
            // "Points" is Resource, "MaxPoints" is MaxRepairResource
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.REPAIRKIT);
            price = price / component.maxPoints * Math.max(component.points, 1);
        }
        return price * itemCount;
    }

    // Reference - GClass1969.CalculateBuyoutBasePriceForSingleItem() (the restriction checking part)
    public passesBuyoutRestrictions(item: Item, isFence: boolean): boolean
    {
        let component: ItemPointsData;
        const buyoutRestrictions = this.dbGlobals.config.TradingSettings.BuyoutRestrictions;
        if (!isFence && this.componentHelper.hasComponent(item, ItemComponentTypes.MEDKIT))
        {
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.MEDKIT);
            return !(component.points/component.maxPoints < buyoutRestrictions.MinMedsResource);
        }
        if (!isFence && this.componentHelper.hasComponent(item, ItemComponentTypes.FOOD_DRINK))
        {
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.FOOD_DRINK);
            return !(component.points < buyoutRestrictions.MinFoodDrinkResource);
        }
        if (!isFence && this.componentHelper.hasComponent(item, ItemComponentTypes.REPAIRABLE))
        {
            component = this.componentHelper.getItemComponentPoints(item, ItemComponentTypes.REPAIRABLE);
            return !(component.maxPoints < component.templateMaxPoints * buyoutRestrictions.MinDurability || component.points < component.maxPoints * buyoutRestrictions.MinDurability);
        }
        return true;
    }

    public isMissingVitalParts(item: Item): boolean
    {
        return this.getMissingVitalPartsCount(item) > 0;
    }

    public getMissingVitalPartsCount(item: Item): number
    {
        //const tpl = this.dbItems[item._tpl];
        //tpl._props.Slots[0].
        return 0;
    }

    public getVitalParts(item: Item): any
    {
        //item.slotId
        return;
    }

    /**
     * Gets ragfair average price for template, accesses the cached price table.
     * @param itemTplId Item Template Id.
     * @returns ItemRagFairCosts - flea tax and average flea price.
     */
    public getItemTplRagfairPrice(itemTplId: string): number
    {
        return this._itemRagfairPriceTable[itemTplId] ?? 0;
    }

    /**
     * Calculate a fresh item template ragfair price. Should be used only once, to generate ragfair price table.
     * 
     * but...
     * 
     * Can be used to always keep item prices up to date, but perhaps it's usage wouldn't make sense,
     * because it's more performance intensive and you could, for example, buy off all specific 
     * item offers and the received price would be based off Static or Dynamic price, which is
     * less accurate that an actual average price based on existing offers.
     * @param itemTplId Item Template Id.
     * @returns number Average flea price
     */
    private getItemTemplateRagfairPrice(itemTplId: string): number
    {
        // sellInOnePiece check is not needed - I'll leave this as a reminder for my goofy aah
        // took me 3 hours to realize that I checked for sellInOnePiece === false and couldn't get
        // fully operational item offers, because a weapon preset with all the mods is sold with "sellInOnePiece" = true
        
        // On the other hand, why non-operational lower receivers of M4A1 cost 250k~ on flea?

        const validOffersForItemTpl = this.ragfairOfferService.getOffersOfType(itemTplId)?.filter(offer => 
        {    
            //console.log(`[validOffersForItemTpl] ${JSON.stringify(offer.user?.memberType)}`);
            const firstItem = offer.items[0];
            if (
                offer.user?.memberType === MemberCategory.TRADER || // no trader offers
                    offer.items.length < 1 || // additional reliability measure
                    offer.requirements.some(requirement => !Object.keys(Money).some(currencyName => Money[currencyName] === requirement._tpl)) || // no barter offers
                    modConfig.ragfairIgnoreAttachments && this.presetHelper.hasPreset(firstItem._tpl) && offer.items.length === 1 || // only "operational" weapon offers if config specifies
                    !modConfig.ragfairIgnoreAttachments && this.presetHelper.hasPreset(firstItem._tpl) && offer.items.length > 1 ||// only "not operational" weapon offers if config specifies
                    !this.presetHelper.hasPreset(firstItem._tpl) && offer.sellInOnePiece // for non-template items ignore "bulk" offers
            ) return false;
            return true;
        })

        // If somehow there were no valid offers (may happen sometimes, usually with event items like pumpkin masks)
        // meaning: validOffersForItemTpl might be 'undefined'
        if (validOffersForItemTpl == null || validOffersForItemTpl?.length < 1)
        {
            // TODO: maybe should change to min instead.
            return Math.max(this.ragfairPriceService.getStaticPriceForItem(itemTplId) ?? 0, this.ragfairPriceService.getDynamicPriceForItem(itemTplId) ?? 0);
        }

        // New implementation with lowest price, should be more precise too.
        if (modConfig.ragfairUseLowestPrice)
        {
            validOffersForItemTpl.sort((a, b) => 
            {
                const aPointsData = this.componentHelper.getRagfairItemComponentPoints(a.items[0]);
                const bPointsData = this.componentHelper.getRagfairItemComponentPoints(b.items[0]);
                const maxPointsComparison = bPointsData.maxPoints - aPointsData.maxPoints;
                const pointsComparison = bPointsData.points - aPointsData.points;
                const requirementsCostComparison = a.requirementsCost - b.requirementsCost; // requirementsCost is always rouble equivalent even if offer requires USD/EUR
                return maxPointsComparison || pointsComparison || requirementsCostComparison;
            });
            // After sorting the first item should have the lowest price and highest condition
            return validOffersForItemTpl[0].requirementsCost;
        }

        // Here we get average price (Old implementation basically)
        // Collect offers with at least 85% durability/resource for decent sample size
        const offersWith85to100PercentPoints = validOffersForItemTpl.filter(offer => 
        {
            const firstItem = offer.items[0];
            const pointsData = this.componentHelper.getRagfairItemComponentPoints(firstItem);
            const originalMaxPtsBoundary = pointsData.templateMaxPoints * 0.85; // 85% of max capacity
            const hasAtLeast85PercentPoints = pointsData.points >= originalMaxPtsBoundary && pointsData.maxPoints >= originalMaxPtsBoundary;
            return hasAtLeast85PercentPoints; 
        });

        return offersWith85to100PercentPoints.map(offer => offer.requirementsCost).reduce((accum, curr) => accum+curr, 0) / offersWith85to100PercentPoints.length;
    }

    public getSingleItemRagfairPrice(item: Item): number
    {
        if (!modConfig.useRagfair) return 0;
        const pointsData = this.componentHelper.getRagfairItemComponentPoints(item);
        // Round, since weapon or armor durability can be float, etc.
        // console.log(`[POINTS DATA] ${JSON.stringify(pointsData)}`);
        // console.log(`[RAGFAIR PRICE DATA] ${JSON.stringify(this.getItemTplRagfairPrice(item._tpl))}`);
        // console.log(`[GET STACK OBJECT COUNT DATA] ${JSON.stringify(this.getItemStackObjectsCount(item))}`);
        return this.getItemTplRagfairPrice(item._tpl) * pointsData.points / pointsData.templateMaxPoints * this.getItemStackObjectsCount(item);
    }

    public getItemRagfairPrice(item: Item, pmcData: IPmcData): number
    {
        const itemAndChildren = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, item._id);
        console.log(`[ITEM AND CHILDREN] ${JSON.stringify(itemAndChildren)}`)
        return itemAndChildren.reduce((accum, curr) => accum + this.getSingleItemRagfairPrice(curr), 0);
    }

    public getItemFromInventoryById(itemId: string, pmcData: IPmcData): Item
    {
        return pmcData.Inventory.items.find(item => item._id === itemId);
    }

    public getItemStackObjectsCount(item: Item): number
    {
        return item.upd?.StackObjectsCount ?? 1;
    }

    public getDogtagLevel(item: Item): number
    {
        return item.upd?.Dogtag.Level ?? 1;
    }

    /**
     * Looking for children is pretty intensive, maybe shouldn't be used, since I only intend to use it for logging.
     * @param item 
     * @param pmcData 
     * @returns 
     */
    public getFullItemCount(item: Item, pmcData: IPmcData): number
    {
        const itemAndChildren = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, item._id);
        return itemAndChildren.reduce((accum, curr) => accum + this.getItemStackObjectsCount(curr), 0);
    }

    /**
     * Formats a number with spaces. (Separates thousands)
     * @param input Number you want to format.
     * @returns Formatted string with spaces.
     */
    public static getNumberWithSpaces(input: number): string 
    {
        const parts = input.toString().split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
        return parts.join(".");
    }

    public convertRoublesToTraderCurrency(roubleAmount: number, traderId: string): number
    {
        const trader = this.dbTraders[traderId];
        if (trader == undefined) console.log(`[${modInfo.name} ${modInfo.version}] Error converting to trader currency. Couldn't find trader! Defaulting to RUB.`);

        const tCurrencyTag = trader?.base?.currency ?? "RUB";
        const currencyTpl = this.paymentHelper.getCurrency(tCurrencyTag);

        if (currencyTpl === Money.ROUBLES) return roubleAmount;

        const targetCurrPrice = this.handbookHelper.getTemplatePrice(currencyTpl);
        return targetCurrPrice ? roubleAmount / targetCurrPrice : 0;
        // return this.handbookHelper.fromRUB(roubleAmount, currencyTpl); doesn't do well, because it Rounds the return value, when it has to be Floored.
    }

    // public getItemRagfairTax(item: Item, pmcData: IPmcData, requirementsValue: number, offerItemCount: number, sellInOnePiece: boolean): number{
    //     return this.ragfairTaxHelper.calculateTax(item, pmcData, requirementsValue, offerItemCount, sellInOnePiece);
    // }
}
