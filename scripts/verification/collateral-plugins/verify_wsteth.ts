import hre from 'hardhat'
import { getChainId } from '../../../common/blockchain-utils'
import { developmentChains, networkConfig } from '../../../common/configuration'
import { fp, bn } from '../../../common/numbers'
import {
  getDeploymentFile,
  getAssetCollDeploymentFilename,
  IAssetCollDeployments,
} from '../../deployment/common'
import { priceTimeout, verifyContract } from '../../deployment/utils'

let deployments: IAssetCollDeployments

async function main() {
  // ********** Read config **********
  const chainId = await getChainId(hre)
  if (!networkConfig[chainId]) {
    throw new Error(`Missing network configuration for ${hre.network.name}`)
  }

  if (developmentChains.includes(hre.network.name)) {
    throw new Error(`Cannot verify contracts for development chain ${hre.network.name}`)
  }

  const assetCollDeploymentFilename = getAssetCollDeploymentFilename(chainId)
  deployments = <IAssetCollDeployments>getDeploymentFile(assetCollDeploymentFilename)

  // Don't need to verify wrapper token because it's canonical

  /********  Verify Lido Wrapped-Staked-ETH - wstETH  **************************/
  await verifyContract(
    chainId,
    deployments.collateral.wstETH,
    [
      {
        priceTimeout: priceTimeout.toString(),
        chainlinkFeed: networkConfig[chainId].chainlinkFeeds.stETHUSD,
        oracleError: fp('0.01').toString(), // 1%: only for stETHUSD feed
        erc20: networkConfig[chainId].tokens.wstETH,
        maxTradeVolume: fp('1e6').toString(), // $1m,
        oracleTimeout: '3600', // 1 hr,
        targetName: hre.ethers.utils.formatBytes32String('ETH'),
        defaultThreshold: fp('0.025').toString(), // 2.5% = 2% + 0.5% stethETH feed oracleError
        delayUntilDefault: bn('86400').toString(), // 24h
      },
      fp('1e-4'), // revenueHiding = 0.01%
      networkConfig[chainId].chainlinkFeeds.stETHETH, // targetPerRefChainlinkFeed
      '86400', // targetPerRefChainlinkTimeout
    ],
    'contracts/plugins/assets/lido/LidoStakedEthCollateral.sol:LidoStakedEthCollateral'
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
