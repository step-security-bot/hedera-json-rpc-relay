// SPDX-License-Identifier: Apache-2.0
// pragma solidity 0.6.12;
pragma solidity ^0.8.9;


contract TokenProxy {
    fallback() external payable {
        address precompileAddress = address(0x167);
        assembly {
            mstore(0, 0x618dc65e000000000000000000000000000000000047b52a)
            calldatacopy(32, 0, calldatasize())

            let result := delegatecall(gas(), precompileAddress, 8, add(24, calldatasize()), 0, 0)
            let size := returndatasize()
            returndatacopy(0, 0, size)
            switch result
            case 0 { revert(0, size) }
            default { return(0, size) }
        }
    }
}
