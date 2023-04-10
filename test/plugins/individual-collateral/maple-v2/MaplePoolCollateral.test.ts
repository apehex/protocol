import collateralTests from '../collateralTests'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { ContractFactory, BigNumberish } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { MockV3Aggregator, MockV3Aggregator__factory, TestICollateral, IMaplePool, MaplePoolMock } from '../../../../typechain'
import { ZERO_ADDRESS } from '../../../../common/constants'
import { bn, fp } from '../../../../common/numbers'
import { CollateralStatus, CollateralOpts, CollateralFixtureContext, DeployCollateralFunc, MakeCollateralFixtureFunc, MintCollateralFunc } from '../pluginTestTypes'
import { resetFork, transferMaplePoolToken, getExpectedPrice, reduceTargetPerRef, increaseTargetPerRef, increaseRefPerTok } from './helpers'
import {
    MAPLE_USDC_POOL,
    MAPLE_WETH_POOL,
    MPL_mcUSDC2_HOLDER,
    MPL_mcWETH1_HOLDER,
    USDC_TOKEN,
    WETH_TOKEN,
    USDC_TO_USD_PRICE_FEED,
    USDC_TO_USD_PRICE_ERROR,
    ETH_TO_USD_PRICE_ERROR,
    PRICE_TIMEOUT,
    ORACLE_TIMEOUT,
    DEFAULT_THRESHOLD,
    DELAY_UNTIL_DEFAULT,
    MAX_TRADE_VOL,
    REVENUE_HIDING,
} from './constants'

// Generic constants

type Fixture<T> = (...args: any[]) => Promise<T>

const emptyFn = () => {return}

// Deployment factory

const deployCollateralFactory = (defaults: CollateralOpts = {}): DeployCollateralFunc => {
    const _deployCollateral = async (opts: CollateralOpts = {}): Promise<TestICollateral> => {
        let _defaults = defaults

        // for the wETH collateral {target} = {ref} = wETH: the oracle should constantly return 1
        if (_defaults.chainlinkFeed == ZERO_ADDRESS) {
            const _mockV3AggregatorFactory = <MockV3Aggregator__factory>(await ethers.getContractFactory('MockV3Aggregator'))

            const _chainlinkFeed = <MockV3Aggregator>await _mockV3AggregatorFactory.deploy(8, bn('1e8'))
            _defaults.chainlinkFeed = _chainlinkFeed.address
        }

        const _opts = { ..._defaults, ...opts }

        const _MaplePoolCollateralFactory: ContractFactory = await ethers.getContractFactory('MaplePoolCollateral')

        const _collateral = <TestICollateral>await _MaplePoolCollateralFactory.deploy(
            {
                erc20: _opts.erc20,
                targetName: _opts.targetName,
                priceTimeout: _opts.priceTimeout,
                chainlinkFeed: _opts.chainlinkFeed,
                oracleError: _opts.oracleError,
                oracleTimeout: _opts.oracleTimeout,
                maxTradeVolume: _opts.maxTradeVolume,
                defaultThreshold: _opts.defaultThreshold,
                delayUntilDefault: _opts.delayUntilDefault,
            },
            _opts.revenueHiding,
            { gasLimit: 2000000000 }
        )
        await _collateral.deployed()

        // sometimes we are trying to test a negative test case and we want this to fail silently
        // fortunately this syntax fails silently because our tools are terrible
        await expect(_collateral.refresh())

        return _collateral
    }

    return _deployCollateral
}

// Collateral fixture factory

const makeCollateralFixtureContextFactory = (defaults: CollateralOpts = {}, price: BigNumberish): MakeCollateralFixtureFunc<CollateralFixtureContext> => {
    const _makeMakeCollateralFixtureContext = (alice: SignerWithAddress, opts: CollateralOpts = {}): Fixture<CollateralFixtureContext> => {
        const _opts = { ...defaults, ...opts }
        const _deployCollateral = deployCollateralFactory(_opts)

        const _makeCollateralFixtureContext = async () => {
            const _mockV3AggregatorFactory = <MockV3Aggregator__factory>(await ethers.getContractFactory('MockV3Aggregator'))
            const _chainlinkFeed = <MockV3Aggregator>await _mockV3AggregatorFactory.deploy(8, price)
            _opts.chainlinkFeed = _chainlinkFeed.address

            const _collateral = await _deployCollateral(_opts)
            const _erc20 = await ethers.getContractAt('IMaplePool', _opts.erc20 as string) // the Maple pool

            return {
                alice: alice,
                collateral: _collateral,
                chainlinkFeed: _chainlinkFeed,
                tok: _erc20,
            }
        }

        return _makeCollateralFixtureContext
    }

    return _makeMakeCollateralFixtureContext
}

// Mock collateral fixture factory

const deployCollateralMockFixtureContextFactory = (defaults: CollateralOpts, price: BigNumberish, symbol: string): Fixture<CollateralFixtureContext> => {
    const _deployCollateralMockContext = async (opts: CollateralOpts = {}): Promise<CollateralFixtureContext> => {
        const _opts = { ...defaults, ...opts }
        const _deployCollateral = deployCollateralFactory(defaults)

        const _mockV3AggregatorFactory = <MockV3Aggregator__factory>(await ethers.getContractFactory('MockV3Aggregator'))

        const _chainlinkFeed = <MockV3Aggregator>await _mockV3AggregatorFactory.deploy(8, price)
        _opts.chainlinkFeed = _chainlinkFeed.address

        const _maplePoolMockFactory = await ethers.getContractFactory('MaplePoolMock')
        const _erc20 = await _maplePoolMockFactory.deploy('Mock MaplePool', 'Mock '.concat(symbol))
        _opts.erc20 = _erc20.address

        const _collateral = await _deployCollateral(_opts)

        return {
            collateral: _collateral,
            chainlinkFeed: _chainlinkFeed,
            tok: _erc20,
        }
    }

    return _deployCollateralMockContext
}

// Maple token minting factory

const mintCollateralToFactory = (holder: string): MintCollateralFunc<CollateralFixtureContext> => {
    const _mintCollateralTo = async (ctx: CollateralFixtureContext, amount: BigNumberish, user: SignerWithAddress, recipient: string) => {
        await transferMaplePoolToken(holder, (ctx.tok as IMaplePool), amount, recipient)
    }

    return _mintCollateralTo
}

// Specific tests factory

const collateralSpecificStatusTestsFactory = (defaults: CollateralOpts, price: BigNumberish, symbol: string): (() => void) => {
    const _collateralSpecificStatusTests = () => {
        it('does revenue hiding correctly', async () => {
            const _deployCollateralMockContext = deployCollateralMockFixtureContextFactory(defaults, price, symbol)
            const { collateral, tok } = await _deployCollateralMockContext({ revenueHiding: fp('0.01') })

            // the exposed refPerTok is 0.99 the max (here current) refPerTok
            await (tok as MaplePoolMock).setRefPerTok(fp('2')) // twice the default rpt
            await collateral.refresh() // refresh actually updates the rpt
            const before = await collateral.refPerTok()
            expect(before).to.equal(fp('1.98'))
            expect(await collateral.status()).to.equal(CollateralStatus.SOUND)

            // Should be SOUND if drops just under 1%
            await (tok as MaplePoolMock).setRefPerTok(fp('1.98001'))
            await collateral.refresh()
            let after = await collateral.refPerTok()
            expect(before).to.eq(after)
            expect(await collateral.status()).to.equal(CollateralStatus.SOUND)

            // Should be DISABLED if drops just over 1%
            await (tok as MaplePoolMock).setRefPerTok(fp('1.97999'))
            await collateral.refresh()
            after = await collateral.refPerTok()
            expect(before).to.be.gt(after)
            expect(await collateral.status()).to.equal(CollateralStatus.DISABLED)
        })
    }

    return _collateralSpecificStatusTests
}

// default parameters for the 2 pools

interface MaplePoolTokenEnumeration {
    testName: string
    tokenName: string
    underlying: string
    holder: string
    MaplePoolToken: string
    chainlinkFeed: string
    oracleError: BigNumberish
    defaultOraclePrice: BigNumberish
}

const all = [
    {
        testName: 'Maple USDC Collateral',
        tokenName: 'MPL-mcUSDC2',
        underlying: USDC_TOKEN,
        holder: MPL_mcUSDC2_HOLDER,
        MaplePoolToken: MAPLE_USDC_POOL,
        oracleError: USDC_TO_USD_PRICE_ERROR,
        chainlinkFeed: USDC_TO_USD_PRICE_FEED, // {target/ref}
        defaultOraclePrice: bn('1e8'), // 8 decimals
    },
    {
        testName: 'Maple wETH Collateral',
        tokenName: 'MPL-mcWETH1',
        underlying: WETH_TOKEN,
        holder: MPL_mcWETH1_HOLDER,
        MaplePoolToken: MAPLE_WETH_POOL,
        oracleError: ETH_TO_USD_PRICE_ERROR,
        chainlinkFeed: ZERO_ADDRESS, // {target/ref} = constant 1 (wETH to ETH), the oracle is a mock
        defaultOraclePrice: bn('1e8'), // 8 decimals
    },
]

// Iterate over both USDC and wETH MaplePool tokens

all.forEach((current: MaplePoolTokenEnumeration) => {
    const defaultCollateralOpts: CollateralOpts = {
        erc20: current.MaplePoolToken,
        targetName: ethers.utils.formatBytes32String('USD'),
        priceTimeout: PRICE_TIMEOUT,
        chainlinkFeed: current.chainlinkFeed,
        oracleTimeout: ORACLE_TIMEOUT,
        oracleError: current.oracleError,
        maxTradeVolume: MAX_TRADE_VOL,
        defaultThreshold: DEFAULT_THRESHOLD,
        delayUntilDefault: DELAY_UNTIL_DEFAULT,
        revenueHiding: REVENUE_HIDING,
    }

    // Run the test suite

    const opts = {
        deployCollateral: deployCollateralFactory(defaultCollateralOpts),
        collateralSpecificConstructorTests: emptyFn,
        collateralSpecificStatusTests: collateralSpecificStatusTestsFactory(defaultCollateralOpts, current.defaultOraclePrice, current.tokenName),
        beforeEachRewardsTest: emptyFn,
        makeCollateralFixtureContext: makeCollateralFixtureContextFactory(defaultCollateralOpts, current.defaultOraclePrice),
        mintCollateralTo: mintCollateralToFactory(current.holder),
        reduceTargetPerRef: reduceTargetPerRef,
        increaseTargetPerRef: increaseTargetPerRef,
        reduceRefPerTok: emptyFn,
        increaseRefPerTok: increaseRefPerTok,
        getExpectedPrice: getExpectedPrice,
        itClaimsRewards: it.skip,
        itChecksTargetPerRefDefault: it,
        itChecksRefPerTokDefault: it.skip,
        itChecksPriceChanges: it,
        itHasRevenueHiding: it.skip,
        resetFork: resetFork,
        collateralName: current.testName,
        chainlinkDefaultAnswer: current.defaultOraclePrice,
    }

    collateralTests(opts)
})
