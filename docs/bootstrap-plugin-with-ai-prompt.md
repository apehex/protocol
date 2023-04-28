# Collateral Plugin Bootstrap

Collateral plugins can be created from an AI prompt.
Below is an example for the Maple liquidity pool collateral, broken into 3 messages

It has been tested with ChatGPT v4.

## Message 1

You are a blockchain AMM researcher and typescript / solidity developer.
You have created ERC20 token contracts to automate liquidity pools in AMMs.

The Reserve Protocol allows anyone to create stablecoins backed by baskets of ERC20 tokens on Ethereum.
Stable asset backed currencies launched on the Reserve protocol are called “RTokens”.
The ERC20 tokens are held inside the Reserve protocol by "collateral" contracts.

Your role is to write a collateral contract that will hold Maple liquidity tokens, such as `MPL-mcUSDC2` (the token given to USDC providers in the Maple protocol).
This contract will be named `MaplePoolCollateral` and will keep track of the value of these tokens, `{tok}`, in relation to the unit of account, `{UoA}`.
For example the value of the token `MPL-mcUSDC2` is generally denoted `{UoA/tok}` and in this particular instance `{USD/MPL-mcUSDC2}`.

To process this value, the contract decomposes `{UoA/tok}` in 3 parts: `{UoA/tok} = {UoA/target} * {target/ref} * {ref/tok}`.

1) `{UoA/target}`, here `{USD/USD}`
2) `{target/ref}`, here `{USD/USDC}`
3) `{ref/tok}`, here `{USDC/MPL-mcUSDC2}`

1) since the unit of account and target units are the same, it doesn't need any processing
2) the value `{target/ref}` is queried from a Chainlink oracle, whose address is 
3) the value `{ref/tok}` is processed by querying the target Maple pool contract

The collateral contract will be written in the solidity language, for the ethereum EVM, and located in the file `MaplePoolCollateral.sol`.
`MaplePoolCollateral` is derived from `AppreciatingFiatCollateral`, a pre-existing contract which implements most of the collateral logic.
`MaplePoolCollateral` will interact with the contract `Pool.sol` from the Maple protocol to compute `{ref/tok}`.

In the following messages I will be giving you the code of the contracts mentioned above.
You will wait until you've received both scripts and then I'll ask for your input.

## Message 2

You'll find below the parent contract, `AppreciatingFiatCollateral`.
Your collateral contract will extend `AppreciatingFiatCollateral` and define:

- a constructor
- the `refresh` method that updates the state of the collateral
- the `_underlyingRefPerTok` method that computes `{ref/tok}`
- the `claimRewards` method that asks the Maple protocol for the rewards associated with the pool tokens it holds
- if necessary, the `tryPrice` method which computes the price of the collateral from its different factors

```solidity
// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../interfaces/IAsset.sol";
import "../../libraries/Fixed.sol";
import "./FiatCollateral.sol";
import "./Asset.sol";
import "./OracleLib.sol";

/**
 * @title AppreciatingFiatCollateral
 * Collateral that may need revenue hiding to become truly "up only"
 *
 * For: {tok} != {ref}, {ref} != {target}, {target} == {UoA}
 * Inheritors _must_ implement _underlyingRefPerTok()
 * Can be easily extended by (optionally) re-implementing:
 *   - tryPrice()
 *   - refPerTok()
 *   - targetPerRef()
 *   - claimRewards()
 * Should not have to re-implement any other methods.
 *
 * Can intentionally disable default checks by setting config.defaultThreshold to 0
 * Can intentionally do no revenue hiding by setting revenueHiding to 0
 */
abstract contract AppreciatingFiatCollateral is FiatCollateral {
    using FixLib for uint192;
    using OracleLib for AggregatorV3Interface;

    // revenueShowing = FIX_ONE.minus(revenueHiding)
    uint192 public immutable revenueShowing; // {1} The maximum fraction of refPerTok to show

    // does not become nonzero until after first refresh()
    uint192 public exposedReferencePrice; // {ref/tok} max ref price observed, sub revenue hiding

    /// @param config.chainlinkFeed Feed units: {UoA/ref}
    /// @param revenueHiding {1} A value like 1e-6 that represents the maximum refPerTok to hide
    constructor(CollateralConfig memory config, uint192 revenueHiding) FiatCollateral(config) {
        require(revenueHiding < FIX_ONE, "revenueHiding out of range");
        revenueShowing = FIX_ONE.minus(revenueHiding);
    }

    /// Can revert, used by other contract functions in order to catch errors
    /// Should not return FIX_MAX for low
    /// Should only return FIX_MAX for high if low is 0
    /// @dev Override this when pricing is more complicated than just a single oracle
    /// @return low {UoA/tok} The low price estimate
    /// @return high {UoA/tok} The high price estimate
    /// @return pegPrice {target/ref} The actual price observed in the peg
    function tryPrice()
        external
        view
        virtual
        override
        returns (
            uint192 low,
            uint192 high,
            uint192 pegPrice
        )
    {
        // {target/ref} = {UoA/ref} / {UoA/target} (1)
        pegPrice = chainlinkFeed.price(oracleTimeout);

        // {UoA/tok} = {target/ref} * {ref/tok} * {UoA/target} (1)
        uint192 p = pegPrice.mul(_underlyingRefPerTok());
        uint192 err = p.mul(oracleError, CEIL);

        low = p - err;
        high = p + err;
        // assert(low <= high); obviously true just by inspection
    }

    /// Should not revert
    /// Refresh exchange rates and update default status.
    /// @dev Should not need to override: can handle collateral with variable refPerTok()
    function refresh() public virtual override {
        if (alreadyDefaulted()) {
            // continue to update rates
            exposedReferencePrice = _underlyingRefPerTok().mul(revenueShowing);
            return;
        }

        CollateralStatus oldStatus = status();

        // Check for hard default
        // must happen before tryPrice() call since `refPerTok()` returns a stored value

        // revenue hiding: do not DISABLE if drawdown is small
        uint192 underlyingRefPerTok = _underlyingRefPerTok();

        // {ref/tok} = {ref/tok} * {1}
        uint192 hiddenReferencePrice = underlyingRefPerTok.mul(revenueShowing);

        // uint192(<) is equivalent to Fix.lt
        if (underlyingRefPerTok < exposedReferencePrice) {
            exposedReferencePrice = hiddenReferencePrice;
            markStatus(CollateralStatus.DISABLED);
        } else if (hiddenReferencePrice > exposedReferencePrice) {
            exposedReferencePrice = hiddenReferencePrice;
        }

        // Check for soft default + save prices
        try this.tryPrice() returns (uint192 low, uint192 high, uint192 pegPrice) {
            // {UoA/tok}, {UoA/tok}, {target/ref}
            // (0, 0) is a valid price; (0, FIX_MAX) is unpriced

            // Save prices if priced
            if (high < FIX_MAX) {
                savedLowPrice = low;
                savedHighPrice = high;
                lastSave = uint48(block.timestamp);
            } else {
                // must be unpriced
                assert(low == 0);
            }

            // If the price is below the default-threshold price, default eventually
            // uint192(+/-) is the same as Fix.plus/minus
            if (pegPrice < pegBottom || pegPrice > pegTop || low == 0) {
                markStatus(CollateralStatus.IFFY);
            } else {
                markStatus(CollateralStatus.SOUND);
            }
        } catch (bytes memory errData) {
            // see: docs/solidity-style.md#Catching-Empty-Data
            if (errData.length == 0) revert(); // solhint-disable-line reason-string
            markStatus(CollateralStatus.IFFY);
        }

        CollateralStatus newStatus = status();
        if (oldStatus != newStatus) {
            emit CollateralStatusChanged(oldStatus, newStatus);
        }
    }

    /// @return {ref/tok} Exposed quantity of whole reference units per whole collateral tokens
    function refPerTok() public view virtual override returns (uint192) {
        return exposedReferencePrice;
    }

    /// Should update in inheritors
    /// @return {ref/tok} Actual quantity of whole reference units per whole collateral tokens
    function _underlyingRefPerTok() internal view virtual returns (uint192);
}
```

## Message 3

In your previous script, you will add an interface to the following contract, `Pool.sol`;

```solidity
// content of Pool.sol
```

The interface will have only the relevant functions to claim rewards and compute `{ref/tok}`.

You will then call these functions:

- in `_underlyingRefPerTok` and return the value as a fixed point integer with 18 decimals
- in `claimRewards` and query the Maple pool for rewards, if any
